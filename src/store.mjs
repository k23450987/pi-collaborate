import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export class CollabError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
export function requireValue(value, name) {
  if (typeof value !== 'string' || !value.trim() || value.length > 131072) throw new CollabError('INVALID_ARGUMENT', `${name} must be a nonempty string (max 128K characters)`);
  return value;
}
const canonical = value => JSON.stringify(value, (_, v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v);
const terminal = status => ['completed', 'failed', 'cancelled'].includes(status);
const parse = row => row ? JSON.parse(row.data) : null;

// This module owns all task transitions and deduplication; transports never author SQL.
export class Store {
  constructor(home, { now = Date.now, readOnly = false } = {}) {
    if(!readOnly){mkdirSync(home, {recursive:true, mode:0o700}); chmodSync(home, 0o700);}
    this.home = home; this.now = now;
    this.db = new DatabaseSync(join(home, 'state.sqlite3'),{readOnly});
    this.db.exec('PRAGMA busy_timeout=5000');
    if(readOnly)return;
    chmodSync(join(home, 'state.sqlite3'), 0o600);
    this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY, pi_id TEXT NOT NULL, thread_id TEXT NOT NULL, status TEXT NOT NULL, updated INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, direction TEXT NOT NULL, delivery TEXT NOT NULL, created INTEGER NOT NULL, ack_at INTEGER, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS questions(id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS results(task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, version INTEGER NOT NULL, created INTEGER NOT NULL, ack_at INTEGER, data TEXT NOT NULL, PRIMARY KEY(task_id,version));
      CREATE TABLE IF NOT EXISTS requests(actor TEXT NOT NULL, id TEXT NOT NULL, digest TEXT NOT NULL, task_id TEXT, response TEXT NOT NULL, PRIMARY KEY(actor,id));
      CREATE INDEX IF NOT EXISTS message_delivery ON messages(direction,delivery,created);
      CREATE INDEX IF NOT EXISTS task_owner ON tasks(pi_id,thread_id,status);`);
  }
  close() { this.db.close(); }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  session(id) { return parse(this.db.prepare('SELECT data FROM sessions WHERE id=?').get(id)); }
  sessions() { return this.db.prepare('SELECT data FROM sessions').all().map(parse); }
  saveSession(session) { this.db.prepare('INSERT OR REPLACE INTO sessions VALUES(?,?)').run(session.id, JSON.stringify(session)); }
  task(id) {
    const t = parse(this.db.prepare('SELECT data FROM tasks WHERE id=?').get(id));
    if (!t) throw new CollabError('TASK_NOT_FOUND', `Task not found: ${id}`); return t;
  }
  tasks(piId, threadId) {
    return this.db.prepare('SELECT data FROM tasks WHERE pi_id=? ORDER BY updated DESC').all(piId).map(parse).filter(t => !threadId || t.threadId === threadId);
  }
  saveTask(t) {
    t.updatedAt = this.now();
    this.db.prepare(`INSERT INTO tasks VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,updated=excluded.updated,data=excluded.data`).run(t.id, t.piId, t.threadId, t.status, t.updatedAt, JSON.stringify(t));
  }
  message(id) {
    const m = parse(this.db.prepare('SELECT data FROM messages WHERE id=?').get(id));
    if (!m) throw new CollabError('MESSAGE_NOT_FOUND', `Message not found: ${id}`); return m;
  }
  saveMessage(m) {
    this.db.prepare(`INSERT INTO messages VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET delivery=excluded.delivery,ack_at=excluded.ack_at,data=excluded.data`).run(m.id, m.taskId, m.direction, m.delivery, m.createdAt, m.ackAt ?? null, JSON.stringify(m));
  }
  addMessage(t, actor, kind, text, extra = {}) {
    const m = {id:randomUUID(), taskId:t.id, piId:t.piId, threadId:t.threadId, attempt:t.attempt, actor, kind, text, direction:actor === 'pi' ? 'codex' : 'pi', delivery:'pending', createdAt:this.now(), ...extra};
    this.saveMessage(m); return m;
  }
  question(id) {
    const q = parse(this.db.prepare('SELECT data FROM questions WHERE id=?').get(id));
    if (!q) throw new CollabError('QUESTION_NOT_FOUND', 'Only a questionId from ask is a valid reply target'); return q;
  }
  saveQuestion(q) { this.db.prepare('INSERT OR REPLACE INTO questions VALUES(?,?,?)').run(q.id, q.taskId, JSON.stringify(q)); }
  authorize(t, actor, piId, threadId) {
    if (t.piId !== piId || (actor === 'codex' && t.threadId !== threadId)) throw new CollabError('WRONG_OWNER', 'This task belongs to another session');
  }
  execute(input, {actor, piId, threadId}) {
    if (!['pi','codex'].includes(actor)) throw new CollabError('INVALID_ACTOR', 'Unknown actor');
    requireValue(piId, 'piId'); if (actor === 'codex') requireValue(threadId, 'threadId');
    if(input.version!==undefined&&(!Number.isSafeInteger(input.version)||input.version<1))throw new CollabError('INVALID_ARGUMENT','version must be a positive integer');
    const action = input.action;
    if (action === 'status') {
      if (!input.taskId) return {tasks:this.tasks(piId, actor === 'codex' ? threadId : null)};
      const t = this.task(input.taskId); this.authorize(t,actor,piId,threadId); return {task:t};
    }
    if (action === 'inbox') {
      let messages=this.inbox(actor,piId,threadId,input.includeAcknowledged);
      if(input.after){const cursor=this.message(input.after);this.authorize(this.task(cursor.taskId),actor,piId,threadId);messages=messages.filter(m=>m.createdAt>cursor.createdAt||(m.createdAt===cursor.createdAt&&m.id>cursor.id));}
      const limit=input.limit??50;if(!Number.isInteger(limit)||limit<1||limit>100)throw new CollabError('INVALID_ARGUMENT','limit must be 1..100');
      const page=messages.slice(0,limit).map(m=>({...m,text:m.text.slice(0,1000),truncated:m.text.length>1000}));
      return {messages:page,more:messages.length>limit,nextAfter:page.at(-1)?.id};
    }
    if (action === 'read') {
      const m = this.message(input.messageId); this.authorize(this.task(m.taskId),actor,piId,threadId);
      return {message:m, question:m.questionId ? this.question(m.questionId) : undefined};
    }
    if (action === 'result') {
      const t = this.task(input.taskId); this.authorize(t,actor,piId,threadId);
      return {task:t, result:this.result(t.id, input.version)};
    }
    requireValue(input.requestId, 'requestId');
    const owner = `${actor}:${actor === 'pi' ? piId : threadId}`;
    // Waiting is observation, not part of the authored operation's identity.
    const {requestId, waitMs, ...body} = input;
    const digest = createHash('sha256').update(canonical({piId,body})).digest('hex');
    return this.transaction(() => {
      const old = this.db.prepare('SELECT * FROM requests WHERE actor=? AND id=?').get(owner, requestId);
      if (old) {
        if (old.digest !== digest) throw new CollabError('REQUEST_CONFLICT', 'requestId already names different content');
        if (old.task_id && !this.db.prepare('SELECT 1 FROM tasks WHERE id=?').get(old.task_id)) throw new CollabError('TASK_PRUNED', 'Original task was pruned; request will not execute again');
        return {...JSON.parse(old.response), duplicate:true};
      }
      let response;
      if (action === 'bind') {
        if (actor !== 'codex') throw new CollabError('FORBIDDEN', 'Only Codex CLI binds a coordinator');
        const s = this.session(piId); if (!s?.online) throw new CollabError('PI_OFFLINE','Pi extension is offline');
        if (s.threadId && s.threadId !== threadId && this.tasks(piId).some(t => !terminal(t.status))) throw new CollabError('BINDING_BUSY','Finish or cancel open tasks before changing coordinator');
        this.saveSession({...s,threadId}); response={session:this.session(piId)};
      } else if (action === 'start') {
        if (actor !== 'codex') throw new CollabError('FORBIDDEN','Only Codex starts a task');
        const s = this.session(piId); if (!s?.online) throw new CollabError('PI_OFFLINE','Pi extension is offline');
        if (s.threadId !== threadId) throw new CollabError('NOT_BOUND','Bind this Pi to the current Codex thread first');
        const text = requireValue(input.text, 'text');
        const t={id:randomUUID(),piId,threadId,status:'pending',attempt:1,resultVersion:0,createdAt:this.now()}; this.saveTask(t);
        response={task:t,message:this.addMessage(t,actor,'task',text)};
      } else {
        const q = action === 'reply' ? this.question(input.questionId) : null;
        const existing = input.messageId && action === 'ack' ? this.message(input.messageId) : null;
        const t = this.task(q?.taskId ?? existing?.taskId ?? input.taskId); this.authorize(t,actor,piId,threadId);
        if (action === 'ack') {
          if (input.messageId) {
            if (existing.direction !== (actor === 'pi' ? 'pi' : 'codex')) throw new CollabError('FORBIDDEN','Only recipient acknowledges a message');
            existing.ackAt ??= this.now(); existing.delivery='acknowledged'; this.saveMessage(existing); response={message:existing};
          } else {
            if (actor !== 'codex') throw new CollabError('FORBIDDEN','Only coordinator collects results');
            const r=this.result(t.id,input.version); if (!r) throw new CollabError('RESULT_PENDING','No result has been committed');
            const row=this.db.prepare('SELECT ack_at FROM results WHERE task_id=? AND version=?').get(t.id,r.version);
            const ackAt=row.ack_at ?? this.now(); this.db.prepare('UPDATE results SET ack_at=? WHERE task_id=? AND version=?').run(ackAt,t.id,r.version);
            for(const {data} of this.db.prepare("SELECT data FROM messages WHERE task_id=? AND direction='codex'").all(t.id)) {
              const m=JSON.parse(data); if(m.resultVersion===r.version){m.ackAt??=ackAt;m.delivery='acknowledged';this.saveMessage(m);}
            }
            response={taskId:t.id,version:r.version,ackAt};
          }
        } else if(action === 'retry') {
          const m=this.message(input.messageId); if(m.taskId!==t.id)throw new CollabError('WRONG_TASK','message belongs to another task');
          if(actor!=='codex')throw new CollabError('FORBIDDEN','Coordinator must authorize retry');
          if(!['unknown','failed'].includes(m.delivery))throw new CollabError('NOT_RETRYABLE','Message is not in an uncertain/failed delivery state');
          m.delivery='pending';delete m.error;this.saveMessage(m);response={message:m};
        } else if(action === 'continue') {
          if(actor!=='codex'||!['completed','failed','cancelled','unknown'].includes(t.status))throw new CollabError('INVALID_STATE','Explicit continue requires a terminal or unknown task');
          if(this.tasks(piId).some(x=>x.id!==t.id&&['running','blocked','unknown'].includes(x.status)))throw new CollabError('PI_BUSY','Another task is active');
          t.attempt++;t.status='pending';delete t.closedAt;this.saveTask(t);
          for(const {data} of this.db.prepare('SELECT data FROM questions WHERE task_id=?').all(t.id)){const open=JSON.parse(data);if(open.state==='open'){open.state='cancelled';this.saveQuestion(open);}}
          for(const {data} of this.db.prepare("SELECT data FROM messages WHERE task_id=? AND delivery='pending'").all(t.id)){const old=JSON.parse(data);this.mark(old.id,'failed',{error:'Superseded by an explicit new attempt'});}
          response={task:t,message:this.addMessage(t,actor,'task',requireValue(input.text,'text'))};
        } else if(action === 'reply') {
          if(q.requester===actor)throw new CollabError('WRONG_RESPONDER','Cannot answer your own question');
          if(q.state!=='open'||q.attempt!==t.attempt||terminal(t.status))throw new CollabError('QUESTION_CLOSED','Question is answered, cancelled, or belongs to an ended attempt');
          const m=this.addMessage(t,actor,'reply',requireValue(input.text,'text'),{questionId:q.id});
          const original=this.message(q.messageId);original.ackAt??=this.now();original.delivery='acknowledged';this.saveMessage(original);
          q.state='answered';q.answerId=m.id;q.answeredAt=this.now();this.saveQuestion(q);response={question:q,message:m};
        } else if(action === 'cancel') {
          if(actor!=='codex')throw new CollabError('FORBIDDEN','Only coordinator cancels a task');
          if(terminal(t.status))throw new CollabError('TASK_TERMINAL','Task is already terminal');
          for(const {data} of this.db.prepare('SELECT data FROM questions WHERE task_id=?').all(t.id)){const open=JSON.parse(data);if(open.state==='open'){open.state='cancelled';this.saveQuestion(open);}}
          // Cancellation is a request, not proof the worker stopped.
          response={task:t,message:this.addMessage(t,actor,'cancel',input.text||'请停止此任务，保存已有证据并 report cancelled。')};
        } else if(action === 'report') {
          if(actor!=='pi')throw new CollabError('FORBIDDEN','Only Pi reports execution state');
          if(terminal(t.status)||t.status==='unknown')throw new CollabError('TASK_TERMINAL','Continue explicitly before further execution');
          if(!['running','blocked','completed','failed','cancelled'].includes(input.state))throw new CollabError('INVALID_STATE','Invalid report state');
          if(t.status==='pending')throw new CollabError('TASK_NOT_STARTED','Task is still queued');
          for(const {data} of this.db.prepare("SELECT data FROM messages WHERE task_id=? AND direction='pi'").all(t.id)){const original=JSON.parse(data);if(original.kind==='task'&&original.attempt===t.attempt){original.ackAt??=this.now();original.delivery='acknowledged';this.saveMessage(original);}}
          t.status=input.state;
          let result;
          if(terminal(t.status)) {
            requireValue(input.text,'result text');t.resultVersion++;t.closedAt=this.now();
            result={taskId:t.id,version:t.resultVersion,attempt:t.attempt,state:t.status,text:input.text,createdAt:this.now()};
            this.db.prepare('INSERT INTO results VALUES(?,?,?,?,?)').run(t.id,result.version,result.createdAt,null,JSON.stringify(result));
            for(const {data} of this.db.prepare('SELECT data FROM questions WHERE task_id=?').all(t.id)){const open=JSON.parse(data);if(open.state==='open'){open.state='cancelled';this.saveQuestion(open);}}
          }
          this.saveTask(t);
          response={task:t,result};
          if(terminal(t.status)||t.status==='blocked')response.message=this.addMessage(t,actor,'report',input.text||t.status,{state:t.status,...(result?{resultVersion:result.version}:{})});
        } else if(action === 'send'||action === 'ask') {
          if(terminal(t.status)||t.status==='unknown')throw new CollabError('TASK_TERMINAL','Use explicit continue to start another attempt');
          const text=requireValue(input.text,'text');
          if(input.delivery && !['steer','followUp'].includes(input.delivery))throw new CollabError('INVALID_ARGUMENT','delivery must be steer or followUp');
          const qid=action==='ask'?randomUUID():undefined;
          const m=this.addMessage(t,actor,action,text,{deliveryMode:input.delivery||'steer',...(qid?{questionId:qid}:{})});
          if(qid)this.saveQuestion({id:qid,taskId:t.id,attempt:t.attempt,requester:actor,state:'open',messageId:m.id,createdAt:this.now()});
          response={message:m,...(qid?{question:this.question(qid)}:{})};
        } else throw new CollabError('UNKNOWN_ACTION',`Unknown action: ${action}`);
      }
      const taskId=response.task?.id||response.message?.taskId||response.taskId||null;
      this.db.prepare('INSERT INTO requests VALUES(?,?,?,?,?)').run(owner,requestId,digest,taskId,JSON.stringify(response));
      return response;
    });
  }
  result(taskId,version) {
    const row=version ? this.db.prepare('SELECT * FROM results WHERE task_id=? AND version=?').get(taskId,Number(version)) : this.db.prepare('SELECT * FROM results WHERE task_id=? ORDER BY version DESC LIMIT 1').get(taskId);
    return row ? {...parse(row),ackAt:row.ack_at} : null;
  }
  inbox(actor,piId,threadId,includeAck=false) {
    return this.db.prepare('SELECT data FROM messages WHERE direction=? ORDER BY created,id').all(actor==='pi'?'pi':'codex').map(parse).filter(m=>m.piId===piId&&(actor==='pi'||!threadId||m.threadId===threadId)&&(includeAck||!m.ackAt));
  }
  pending(piId,direction) { return this.db.prepare("SELECT data FROM messages WHERE direction=? AND delivery='pending' ORDER BY created,rowid").all(direction).map(parse).filter(m=>m.piId===piId); }
  mark(id,delivery,extra={}) { const m=this.message(id);if(m.ackAt)return m;Object.assign(m,extra,{delivery});this.saveMessage(m);return m; }
  reservePi(id) {
    return this.transaction(()=>{
      const m=this.message(id);const t=this.task(m.taskId);
      if(m.delivery!=='pending')return null;
      if(m.attempt!==t.attempt||terminal(t.status)){this.mark(id,'failed',{error:'Task attempt ended'});return null;}
      const active=this.tasks(t.piId).find(x=>['running','blocked','unknown'].includes(x.status));
      if(active&&active.id!==t.id)return null;
      if(m.kind==='task') {t.status='running';this.saveTask(t);}
      this.mark(id,'submitting');return m;
    });
  }
  recover(piId,visibleIds) {
    this.transaction(()=>{
      const uncertain=new Set();
      for(const m of this.inbox('pi',piId,null,true)) {
        if(['submitting','submitted','unknown'].includes(m.delivery)) {
          if(visibleIds.has(m.id))this.mark(m.id,'submitted');
          else {this.mark(m.id,'unknown',{error:'Delivery interrupted; inspect before explicit retry'});uncertain.add(m.taskId);}
        }
      }
      for(const t of this.tasks(piId))if(['running','blocked'].includes(t.status)||uncertain.has(t.id)){t.status='unknown';this.saveTask(t);}
      // A send interrupted before receiving an app-server response must be reconciled, not blindly retried.
      for(const {data} of this.db.prepare("SELECT data FROM messages WHERE direction='codex' AND delivery='submitting'").all()) {
        const m=JSON.parse(data);if(m.piId===piId)this.mark(m.id,'unknown',{error:'App-server response lost; reconcile delivery'});
      }
    });
  }
  prune({dryRun=true,taskDays=30,eventDays=7,automatic=true}={}) {
    if(!automatic)return {tasks:[],messages:[],disabled:true};
    if(!Number.isFinite(taskDays)||taskDays<0||!Number.isFinite(eventDays)||eventDays<0)throw new CollabError('INVALID_ARGUMENT','Retention days must be nonnegative numbers');
    const work=()=>{
      const taskCut=this.now()-taskDays*86400000,eventCut=this.now()-eventDays*86400000;
      const tasks=this.db.prepare('SELECT data FROM tasks WHERE updated<?').all(taskCut).map(parse).filter(t=>{
        if(!terminal(t.status))return false;
        if(this.db.prepare('SELECT 1 FROM results WHERE task_id=? AND (ack_at IS NULL OR ack_at>?)').get(t.id,taskCut))return false;
        if(this.db.prepare('SELECT 1 FROM messages WHERE task_id=? AND ack_at IS NULL').get(t.id))return false;
        return !this.db.prepare('SELECT data FROM questions WHERE task_id=?').all(t.id).some(row=>parse(row).state==='open');
      }).map(t=>t.id);
      // Keep task-start history and questions; prune only collected ordinary notices.
      const messages=this.db.prepare("SELECT id,data FROM messages WHERE ack_at<? AND delivery='acknowledged'").all(eventCut).filter(row=>['send','report'].includes(parse(row).kind)).map(row=>row.id);
      if(!dryRun) {
        for(const id of messages){this.db.prepare('DELETE FROM messages WHERE id=?').run(id);this.db.prepare("UPDATE requests SET response=json_remove(response,'$.message.text') WHERE json_extract(response,'$.message.id')=?").run(id);}
        for(const id of tasks){this.db.prepare('DELETE FROM tasks WHERE id=?').run(id);this.db.prepare("UPDATE requests SET response=? WHERE task_id=?").run(JSON.stringify({pruned:true,taskId:id}),id);}
      }
      return {tasks,messages,dryRun};
    };
    return dryRun?work():this.transaction(work);
  }
}
