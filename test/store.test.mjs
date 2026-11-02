import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {Store} from '../src/store.mjs';
import {waitFor} from '../src/wait.mjs';

function fixture(t) {
  const home=mkdtempSync('/private/tmp/collab-store-');let now=1000000;
  const s=new Store(home,{now:()=>now});t.after(()=>{s.close();rmSync(home,{recursive:true,force:true});});
  s.saveSession({id:'pi',online:true,threadId:'codex'});
  const codex={actor:'codex',piId:'pi',threadId:'codex'},pi={actor:'pi',piId:'pi'};let n=0;
  const run=(action,body={},actor=codex)=>s.execute({action,requestId:'req-'+ ++n,...body},actor);
  const start=()=>run('start',{text:'Do one existing-session task'});
  const ackAll=()=>{
    for(const m of s.inbox('pi','pi'))run('ack',{messageId:m.id},pi);
    for(const m of s.inbox('codex','pi','codex'))run('ack',{messageId:m.id});
  };
  return {s,run,start,pi,codex,ackAll,setTime:value=>now=value};
}
test('lost submission response can be retried without a second task',t=>{
  const {s,codex}=fixture(t);const input={action:'start',requestId:'stable-dispatch',text:'task'};
  const first=s.execute(input,codex),retry=s.execute(input,codex);
  assert.equal(retry.task.id,first.task.id);assert.equal(retry.message.id,first.message.id);assert.equal(s.tasks('pi').length,1);
  assert.throws(()=>s.execute({...input,text:'different'},codex),{code:'REQUEST_CONFLICT'});
});
test('wait timeout leaves question open; late reply uses questionId, never a send id',async t=>{
  const {s,start,run,pi}=fixture(t);const {task,message}=start();s.reservePi(message.id);
  const ask=run('ask',{taskId:task.id,text:'Need a decision'},pi);
  const wait=await waitFor(s,{questionId:ask.question.id,waitMs:5});assert.equal(wait.status,'pending');
  assert.equal(s.question(ask.question.id).state,'open');
  const ordinary=run('send',{taskId:task.id,text:'progress'},pi);
  assert.throws(()=>run('reply',{questionId:ordinary.message.id,text:'wrong'}),{code:'QUESTION_NOT_FOUND'});
  const answer=run('reply',{questionId:ask.question.id,text:'approved within original scope'});
  assert.equal(answer.question.state,'answered');assert.equal(answer.message.piId,'pi');
  assert.equal((await waitFor(s,{questionId:ask.question.id,waitMs:0})).answer.text,'approved within original scope');
  assert.throws(()=>run('reply',{questionId:ask.question.id,text:'second answer'}),{code:'QUESTION_CLOSED'});
});
test('one Pi executes one task; corrections do not steal ownership or complete it',t=>{
  const {s,start,run,pi}=fixture(t);const a=start(),b=start();
  assert.ok(s.reservePi(a.message.id));assert.equal(s.reservePi(b.message.id),null);
  const correction=run('send',{taskId:a.task.id,text:'first correction'});assert.ok(s.reservePi(correction.message.id));
  run('send',{taskId:a.task.id,text:'received and working'},pi);
  assert.equal(s.task(a.task.id).status,'running');assert.equal(s.result(a.task.id),null);
  run('report',{taskId:a.task.id,state:'completed',text:'verified result'},pi);
  assert.ok(s.reservePi(b.message.id));assert.equal(s.task(b.task.id).status,'running');
});
test('results, notification and terminal state commit together and survive reopen',t=>{
  const {s,start,run,pi}=fixture(t);const a=start();s.reservePi(a.message.id);
  assert.throws(()=>run('report',{taskId:a.task.id,state:'completed'},pi));assert.equal(s.task(a.task.id).status,'running');assert.equal(s.result(a.task.id),null);
  const result=run('report',{taskId:a.task.id,state:'completed',text:'immutable result'},pi);
  assert.equal(result.message.resultVersion,1);assert.equal(s.result(a.task.id).ackAt,null);
  const another=new Store(s.home);try{assert.equal(another.result(a.task.id).text,'immutable result');}finally{another.close();}
  const ack=run('ack',{taskId:a.task.id,version:1});assert.equal(run('ack',{taskId:a.task.id,version:1}).ackAt,ack.ackAt);
  assert.equal(s.result(a.task.id).text,'immutable result');
  const next=run('continue',{taskId:a.task.id,text:'correct the result'});assert.equal(next.task.attempt,2);s.reservePi(next.message.id);
  run('report',{taskId:a.task.id,state:'completed',text:'second version'},pi);
  assert.equal(s.result(a.task.id,1).text,'immutable result');assert.equal(s.result(a.task.id,2).text,'second version');
});
test('coordinator/Pi ownership is enforced independently of connection names',t=>{
  const {s,start,pi,run}=fixture(t);const a=start();s.reservePi(a.message.id);
  assert.throws(()=>s.execute({action:'status',taskId:a.task.id},{actor:'codex',piId:'pi',threadId:'wrong'}),{code:'WRONG_OWNER'});
  assert.throws(()=>s.execute({action:'status',taskId:a.task.id},{actor:'codex',piId:'wrong',threadId:'codex'}),{code:'WRONG_OWNER'});
  assert.throws(()=>run('result',{taskId:a.task.id,version:0}),{code:'INVALID_ARGUMENT'});
  assert.throws(()=>s.execute({action:'report',taskId:a.task.id,state:'completed',text:'bad',requestId:'x'},{...pi,piId:'other'}),{code:'WRONG_OWNER'});
  assert.throws(()=>s.execute({action:'bind',requestId:'rebind'},{actor:'codex',piId:'pi',threadId:'other'}),{code:'BINDING_BUSY'});
  const cancel=run('cancel',{taskId:a.task.id});assert.equal(cancel.task.status,'running');
  run('report',{taskId:a.task.id,state:'cancelled',text:'stopped and preserved evidence'},pi);
  assert.equal(s.task(a.task.id).status,'cancelled');
});
test('cancellation releases a blocking question without pretending the task has stopped',async t=>{
  const {s,start,run,pi}=fixture(t);const a=start();s.reservePi(a.message.id);
  const q=run('ask',{taskId:a.task.id,text:'Need input'},pi);run('cancel',{taskId:a.task.id});
  assert.equal((await waitFor(s,{questionId:q.question.id,waitMs:0})).status,'cancelled');
  assert.equal(s.task(a.task.id).status,'running');
});
test('reload never silently replays an uncertain task or steals the execution lane',t=>{
  const {s,start,run}=fixture(t);const a=start(),b=start();s.reservePi(a.message.id);
  s.recover('pi',new Set());assert.equal(s.message(a.message.id).delivery,'unknown');assert.equal(s.task(a.task.id).status,'unknown');
  assert.equal(s.reservePi(b.message.id),null);assert.equal(s.pending('pi','pi').length,1);
  const continued=run('continue',{taskId:a.task.id,text:'I inspected prior effects; continue carefully'});
  assert.equal(continued.task.attempt,2);assert.ok(s.reservePi(continued.message.id));
});
test('cleanup protects uncollected results and retains idempotency tombstones',t=>{
  const {s,start,run,pi,ackAll,codex,setTime}=fixture(t);
  const input={action:'start',requestId:'do-not-reexecute',text:'task'};const a=s.execute(input,codex);s.reservePi(a.message.id);
  run('report',{taskId:a.task.id,state:'completed',text:'must not be lost'},pi);
  setTime(40*86400000);assert.equal(s.prune({dryRun:true}).tasks.length,0);
  run('ack',{taskId:a.task.id,version:1});ackAll();
  setTime(50*86400000);assert.equal(s.prune().tasks.length,0);
  setTime(72*86400000);const preview=s.prune();assert.deepEqual(preview.tasks,[a.task.id]);assert.ok(s.result(a.task.id));
  s.prune({dryRun:false});assert.throws(()=>s.task(a.task.id),{code:'TASK_NOT_FOUND'});
  assert.throws(()=>s.execute(input,codex),{code:'TASK_PRUNED'});
});
test('observed/submitted is never overwritten over an explicit collection ack',t=>{
  const {s,start,run,pi}=fixture(t);const a=start();s.reservePi(a.message.id);run('ack',{messageId:a.message.id},pi);
  s.mark(a.message.id,'submitted');assert.equal(s.message(a.message.id).delivery,'acknowledged');
});
test('read-only result/status/prune preview work without schema or filesystem writes',t=>{
  const {s,start,run,pi}=fixture(t);const a=start();s.reservePi(a.message.id);run('report',{taskId:a.task.id,state:'completed',text:'durable'},pi);
  const reader=new Store(s.home,{readOnly:true});try{
    assert.equal(reader.result(a.task.id).text,'durable');assert.equal(reader.task(a.task.id).status,'completed');
    assert.doesNotThrow(()=>reader.prune({dryRun:true}));
    assert.throws(()=>reader.execute({action:'ack',taskId:a.task.id,version:1,requestId:'readonly-write'},{actor:'codex',piId:'pi',threadId:'codex'}));
  }finally{reader.close();}
});
