#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFileSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { Store, CollabError } from '../src/store.mjs';
import { stateHome } from '../src/paths.mjs';
import { call } from '../src/ipc.mjs';
import { waitFor } from '../src/wait.mjs';

const HELP=`pi-collab — Codex ↔ existing Pi sessions (no pi-intercom required)

Usage: pi-collab [options] <command>
  list                            List Pi extension sessions
  bind --pi ID                    Bind Pi to --thread / CODEX_THREAD_ID
  start --pi ID --text TEXT        Dispatch a task, returning taskId
  send --task ID --text TEXT       Send a correction or ordinary message
  ask --task ID --text TEXT        Ask; optional --wait-ms (default returns immediately)
  reply --question ID --text TEXT  Answer an explicit question
  status [--pi ID | --task ID]     Inspect task state
  read --message ID               Read without acknowledging
  inbox [--pi ID]                  List uncollected inbound messages
                                  --limit 50 --after <messageId> pages one Pi inbox
  result --task ID [--version N]   Read committed result, even while Pi is offline
  ack --message ID                Acknowledge collection of a message
  ack --task ID --version N       Acknowledge a result version (not approval)
  continue --task ID --text TEXT   Explicitly start the next attempt
  cancel --task ID                 Request cancellation; does not claim Pi stopped
  retry --message ID              Explicit retry of unknown/failed delivery
  wait --task ID [--wait-ms N]     Bounded local wait; timeout never cancels work
  prune [--dry-run | --apply]     Preview retention cleanup by default

Options:
  --home PATH                     State directory (or PI_COLLAB_HOME)
  --pi ID                         Exact Pi session UUID
  --thread ID                     Codex thread UUID (or CODEX_THREAD_ID)
  --request-id ID                 Stable idempotency key for every mutation
  --text-file PATH                Read message from UTF-8 file
  --delivery steer|followUp       Corrections default to steer
  --include-acknowledged          Include collected inbox messages
  --json                          Output is always JSON except --help

If --request-id is omitted, a generated key is printed on stderr before submission.
Retry uncertain submissions using that same key and identical content.
`;
let store;
try {
  const strings=['home','pi','thread','task','text','text-file','question','message','version','request-id','wait-ms','delivery','after','limit'];
  const booleans=['help','json','dry-run','apply','include-acknowledged'];
  const options=Object.fromEntries([...strings.map(k=>[k,{type:'string'}]),...booleans.map(k=>[k,{type:'boolean'}])]);
  const {values:v,positionals}=parseArgs({options,allowPositionals:true});
  if(v.help||positionals.length===0){console.log(HELP);process.exit(0);}
  if(positionals[0]==='task')positionals.shift();
  const action=positionals[0];if(positionals.length!==1)throw new Error('Expected one command');
  const home=v.home||stateHome();
  if(!existsSync(join(home,'state.sqlite3'))){
    if(action==='list'){console.log(JSON.stringify({ok:true,sessions:[]}));process.exit(0);}
    throw new CollabError('NOT_INITIALIZED','Start Pi with this extension first; no state database exists');
  }
  store=new Store(home,{readOnly:true});
  const makeWritable=()=>{store.close();store=new Store(home);};
  const threadId=v.thread||process.env.CODEX_THREAD_ID;
  if(action==='list'){
    const sessions=store.sessions().map(s=>({...s,online:s.online&&Date.now()-s.lastSeen<30000&&existsSync(s.socket)}));
    console.log(JSON.stringify({ok:true,sessions},null,2));
  }else if(action==='prune'){
    const configFile=join(home,'config.json');const config=existsSync(configFile)?JSON.parse(readFileSync(configFile,'utf8')):{};
    if(v.apply&&v['dry-run'])throw new Error('Choose --apply or --dry-run');
    if(v.apply)makeWritable();
    console.log(JSON.stringify({ok:true,...store.prune({dryRun:!v.apply,taskDays:config.taskRetentionDays??30,eventDays:config.eventRetentionDays??7})},null,2));
  }else{
    if(!threadId)throw new CollabError('THREAD_REQUIRED','Set CODEX_THREAD_ID or pass --thread');
    const taskId=v.task||(v.question?store.question(v.question).taskId:v.message?store.message(v.message).taskId:undefined);
    const piId=v.pi||(taskId?store.task(taskId).piId:undefined);
    const input={action,...(taskId?{taskId}:{}),...(v.question?{questionId:v.question}:{}),...(v.message?{messageId:v.message}:{}),...(v.version?{version:Number(v.version)}:{}),...(v.delivery?{delivery:v.delivery}:{}),...(v.after?{after:v.after}:{}),...(v.limit?{limit:Number(v.limit)}:{})};
    if(v.text!==undefined&&v['text-file'])throw new Error('Choose --text or --text-file');
    const text=v['text-file']?readFileSync(v['text-file'],'utf8'):v.text;
    if(text!==undefined)input.text=text;
    let result;
    const reads=['status','inbox','result','read'];
    const localWrites=['ack','send','ask','reply','cancel','continue','retry'];
    if(action==='wait'){
      if(!taskId)throw new Error('--task is required');
      store.execute({action:'status',taskId},{actor:'codex',piId,threadId});
      result=await waitFor(store,{taskId,waitMs:Number(v['wait-ms']??600000)});
    }else if(!piId&&['status','inbox'].includes(action)){
      if(action==='status')result={tasks:store.sessions().flatMap(s=>store.tasks(s.id,threadId))};
      else {
        const messages=store.sessions().flatMap(s=>store.inbox('codex',s.id,threadId,!!v['include-acknowledged'])).sort((a,b)=>a.createdAt-b.createdAt);
        result={messages:messages.slice(0,50).map(m=>({...m,text:m.text.slice(0,1000),truncated:m.text.length>1000})),more:messages.length>50,hint:'Use --pi with --after and --limit to paginate a specific session'};
      }
    }else{
      if(!piId)throw new Error('--pi or --task is required');
      input.includeAcknowledged=!!v['include-acknowledged'];
      if(!reads.includes(action)){
        input.requestId=v['request-id']||randomUUID();
        if(!v['request-id'])console.error(JSON.stringify({requestId:input.requestId}));
      }
      const session=store.session(piId);
      if(reads.includes(action))result=store.execute(input,{actor:'codex',piId,threadId});
      else if(session?.online&&existsSync(session.socket)){
        try{result=await call(session.socket,{piId,epoch:session.epoch,threadId,input});}
        catch(e){if(localWrites.includes(action)&&['ECONNREFUSED','ENOENT'].includes(e.code)){makeWritable();result=store.execute(input,{actor:'codex',piId,threadId});}else throw e;}
      }else if(localWrites.includes(action)){makeWritable();result=store.execute(input,{actor:'codex',piId,threadId});}
      else throw new CollabError('PI_OFFLINE','Open Pi with the extension before binding or dispatching');
      if(action==='ask'&&v['wait-ms']!==undefined)result={...result,wait:await waitFor(store,{questionId:result.question.id,waitMs:Number(v['wait-ms'])})};
    }
    console.log(JSON.stringify({ok:true,...(input.requestId?{requestId:input.requestId}:{}),...result},null,2));
  }
}catch(e){console.error(JSON.stringify({ok:false,code:e.code||'ERROR',error:e.message}));process.exitCode=1;}
finally{store?.close();}
