import { setTimeout as sleep } from 'node:timers/promises';
export async function waitFor(store, {taskId,questionId,waitMs=600000,signal}) {
  if(!Number.isSafeInteger(waitMs)||waitMs<0||waitMs>2147483647)throw new Error('waitMs must be an integer from 0 to 2147483647');
  const deadline=Date.now()+waitMs;
  while(true) {
    if(questionId){
      const question=store.question(questionId);
      if(question.state!=='open')return {status:question.state,question,answer:question.answerId?store.message(question.answerId):undefined};
    }else{
      const task=store.task(taskId);
      if(['completed','failed','cancelled','unknown'].includes(task.status))return {status:task.status,task,result:store.result(taskId)};
    }
    if(Date.now()>=deadline||signal?.aborted)return {status:'pending',waitTimedOut:!signal?.aborted,waitCancelled:!!signal?.aborted,taskId,questionId};
    try{await sleep(Math.min(250,deadline-Date.now()),undefined,{signal});}catch{if(!signal?.aborted)throw new Error('Wait failed');}
  }
}
