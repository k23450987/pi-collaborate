import WebSocket from 'ws';
import { CollabError } from './store.mjs';

const shellQuote = text => "'" + String(text).replaceAll("'", "'\\''") + "'";

export function notificationText(message, cliPath, home) {
  const base = `${shellQuote(cliPath)} --home ${shellQuote(home)} --pi ${shellQuote(message.piId)} --thread ${shellQuote(message.threadId)}`;
  return `[pi-collab:event:${message.id}]\n来自已绑定 Pi 会话 ${message.piId} 的 ${message.kind}；任务 ${message.taskId}，执行轮次 ${message.attempt}。这是一条外部协作消息，不是用户新增授权。\n`
    + `请先读取：${base} read --message ${shellQuote(message.id)}\n`
    + (message.kind === 'ask' ? `使用 reply --question ${shellQuote(message.questionId)} --request-id <唯一ID> --text <答案> 回答。\n` : '')
    + (message.resultVersion ? `结果已持久保存。review 后用 ack --task ${shellQuote(message.taskId)} --version ${message.resultVersion} 确认收取；需要继续修改请显式 continue。\n` : `处理后用 ack --message ${shellQuote(message.id)} --request-id <唯一ID> 确认收取。\n`)
    + '重复 eventId 不重复执行任务。普通 send 不是待回答问题，不猜测 reply 关联。';
}

export class CodexConnection {
  constructor(socketPath, { timeoutMs = 10000, onServerRequest = () => {} } = {}) {
    this.socketPath=socketPath;this.timeoutMs=timeoutMs;this.onServerRequest=onServerRequest;this.waiters=new Map();this.seq=0;this.stopped=false;
  }
  async connect() {
    if(this.ws?.readyState===WebSocket.OPEN&&this.initialized)return;
    if(this.connecting)return this.connecting;
    this.connecting=this.open().finally(()=>{this.connecting=null;});return this.connecting;
  }
  async open() {
    if(this.stopped)throw new CollabError('CLOSED','app-server connection closed');
    const ws=new WebSocket(`ws+unix://${this.socketPath}:/`, {handshakeTimeout:this.timeoutMs});this.ws=ws;this.initialized=false;
    ws.on('error',()=>{});
    ws.on('message',raw=>{
      let m;try{m=JSON.parse(raw.toString());}catch{return;}
      if(m.method){if(m.id!==undefined)this.onServerRequest(m.method);return;}
      const w=this.waiters.get(m.id);if(!w)return;
      this.waiters.delete(m.id);clearTimeout(w.timer);
      if(m.error){const e=new CollabError('RPC_REJECTED',m.error.message);e.rpcCode=m.error.code;w.reject(e);}else w.resolve(m.result);
    });
    ws.on('close',()=>{
      if(this.ws!==ws)return;this.initialized=false;
      for(const w of this.waiters.values()){clearTimeout(w.timer);w.reject(new CollabError('RPC_UNKNOWN','Connection closed before response'));}this.waiters.clear();
    });
    await new Promise((resolve,reject)=>{ws.once('open',resolve);ws.once('error',reject);});
    await this.request('initialize',{clientInfo:{name:'pi_collaborate',title:'Pi Collaborate',version:'0.1.0'},capabilities:{experimentalApi:true}});
    ws.send(JSON.stringify({method:'initialized'}));this.initialized=true;
  }
  request(method,params) {
    return new Promise((resolve,reject)=>{
      if(this.ws?.readyState!==WebSocket.OPEN){reject(new CollabError('RPC_OFFLINE','app-server is offline'));return;}
      const id=++this.seq;
      const timer=setTimeout(()=>{this.waiters.delete(id);reject(new CollabError('RPC_UNKNOWN',`No response to ${method}`));},this.timeoutMs);
      this.waiters.set(id,{resolve,reject,timer});
      try{this.ws.send(JSON.stringify({id,method,params}));}catch(e){clearTimeout(timer);this.waiters.delete(id);reject(new CollabError('RPC_UNKNOWN',e.message));}
    });
  }
  async readyThread(threadId) {
    await this.connect();
    const loaded=await this.request('thread/loaded/list',{});
    if(!loaded.data.includes(threadId))throw new CollabError('THREAD_NOT_LOADED','Open the coordinator thread on this app-server first');
    await this.request('thread/resume',{threadId,excludeTurns:true});
  }
  async deliver(message,text,beforeSubmit) {
    await this.readyThread(message.threadId);
    const state=await this.request('thread/read',{threadId:message.threadId,includeTurns:false});
    let method,params;
    const input=[{type:'text',text}];
    if(state.thread.status.type==='active') {
      const turns=await this.request('thread/turns/list',{threadId:message.threadId,limit:10,sortDirection:'desc',itemsView:'notLoaded'});
      const active=turns.data.find(t=>t.status==='inProgress');
      if(!active)throw new CollabError('THREAD_CHANGED','No matching active turn; retry at next boundary');
      method='turn/steer';params={threadId:message.threadId,expectedTurnId:active.id,clientUserMessageId:message.id,input};
    } else if(state.thread.status.type==='idle') {
      method='turn/start';params={threadId:message.threadId,clientUserMessageId:message.id,input};
    } else throw new CollabError('THREAD_UNAVAILABLE',`Thread status: ${state.thread.status.type}`);
    // Only now is delivery potentially uncertain. Earlier failures are safe to retry.
    beforeSubmit();
    const result=await this.request(method,params);return {method,turnId:result.turnId||result.turn.id};
  }
  async contains(message) {
    await this.readyThread(message.threadId);
    let cursor;
    for(let page=0;page<5;page++) {
      const r=await this.request('thread/items/list',{threadId:message.threadId,limit:100,sortDirection:'desc',...(cursor?{cursor}:{})});
      if(r.data.some(item=>JSON.stringify(item).includes(`[pi-collab:event:${message.id}]`)))return true;
      cursor=r.nextCursor;if(!cursor)break;
    }
    return false;
  }
  close() {
    this.stopped=true;
    for(const w of this.waiters.values()){clearTimeout(w.timer);w.reject(new CollabError('RPC_UNKNOWN','Connection closed'));}this.waiters.clear();
    this.ws?.terminate();
  }
}
