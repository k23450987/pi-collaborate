import net from 'node:net';
import { chmodSync, existsSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Store, CollabError } from './store.mjs';
import { socketPath, codexSocket } from './paths.mjs';
import { call, MAX_FRAME } from './ipc.mjs';
import { CodexConnection, notificationText } from './codex.mjs';

export class Runtime {
  constructor({home,piId,name,cwd,cliPath,deliver,visibleIds=new Set(),now=Date.now,codex,config={}}) {
    Object.assign(this,{home,piId,name,cwd,cliPath,deliver,visibleIds,now});
    this.config={autoCleanup:true,taskRetentionDays:30,eventRetentionDays:7,...config};
    if(typeof this.config.autoCleanup!=='boolean'||!['taskRetentionDays','eventRetentionDays'].every(k=>Number.isFinite(this.config[k])&&this.config[k]>=1))throw new CollabError('INVALID_CONFIG','autoCleanup must be boolean; retention days must be numbers >= 1');
    this.store=new Store(home,{now});this.epoch=randomUUID();this.path=socketPath(home,piId);
    this.codex=codex||new CodexConnection(codexSocket(),{onServerRequest:method=>{this.lastError=`Codex requires interaction (${method}); respond in the Codex UI. Pi Collaborate never grants approvals.`;}});this.clients=new Set();this.stopped=false;
  }
  async start() {
    if(existsSync(this.path)) {
      try{await call(this.path,{action:'ping'},{timeoutMs:1000});throw new CollabError('SESSION_HELD','This Pi session is already hosted');}
      catch(e){if(!['ECONNREFUSED','ENOENT'].includes(e.code))throw e;unlinkSync(this.path);}
    }
    const old=this.store.session(this.piId);
    this.store.recover(this.piId,this.visibleIds);
    this.server=net.createServer(socket=>this.accept(socket));
    await new Promise((resolve,reject)=>{this.server.once('error',reject);this.server.listen(this.path,resolve);});chmodSync(this.path,0o600);
    this.store.saveSession({...old,id:this.piId,name:this.name||this.piId,cwd:this.cwd,epoch:this.epoch,socket:this.path,online:true,lastSeen:this.now()});
    this.cleanup();this.timer=setInterval(()=>this.tick(),1000);this.timer.unref();await this.tick();return this;
  }
  accept(socket) {
    this.clients.add(socket);socket.on('close',()=>this.clients.delete(socket));socket.on('error',()=>{});socket.setEncoding('utf8');socket.setTimeout(15000,()=>socket.destroy());let data='',handled=false;
    socket.on('data',chunk=>{
      if(handled)return;data+=chunk;
      if(Buffer.byteLength(data)>MAX_FRAME){handled=true;socket.end(JSON.stringify({ok:false,code:'FRAME_TOO_LARGE',error:'Request exceeds 1 MiB'})+'\n');return;}
      if(!data.includes('\n'))return;handled=true;
      Promise.resolve().then(async()=>{
        const p=JSON.parse(data.split('\n')[0]);
        if(p.action==='ping')return {piId:this.piId,epoch:this.epoch};
        if(p.piId!==this.piId||p.epoch!==this.epoch)throw new CollabError('STALE_ENDPOINT','Session endpoint changed; list sessions again');
        const input=p.input;
        if(input.action==='bind')await this.codex.readyThread(p.threadId);
        const result=this.store.execute(input,{actor:'codex',piId:this.piId,threadId:p.threadId});
        setImmediate(()=>this.tick());return result;
      }).then(result=>socket.end(JSON.stringify({ok:true,result})+'\n'),error=>socket.end(JSON.stringify({ok:false,code:error.code||'ERROR',error:error.message})+'\n'));
    });
  }
  execute(input) {
    const result=this.store.execute(input,{actor:'pi',piId:this.piId});setImmediate(()=>this.tick());return result;
  }
  cleanup() {
    this.store.prune({dryRun:false,automatic:this.config.autoCleanup,taskDays:this.config.taskRetentionDays,eventDays:this.config.eventRetentionDays});this.cleanedAt=this.now();
  }
  async tick() {
    if(this.stopped||this.ticking)return;this.ticking=true;
    try {
      const session=this.store.session(this.piId);if(session?.epoch!==this.epoch)return;
      this.store.saveSession({...session,lastSeen:this.now()});
      if(this.now()-this.cleanedAt>3600000)this.cleanup();
      for(const pending of this.store.pending(this.piId,'pi')) {
        if(this.stopped)break;
        if(pending.deliveryMode==='followUp'&&this.canFollowUp&&!this.canFollowUp())continue;
        const m=this.store.reservePi(pending.id);if(!m)continue;
        try{
          await this.deliver(m);if(this.stopped)break;this.store.mark(m.id,'submitted');
        }catch(e){if(!this.stopped)this.store.mark(m.id,'unknown',{error:e.message});}
      }
      if(this.now()<(this.nextCodexTry||0))return;
      // Reconcile ambiguous app-server submissions from history before considering any retry.
      const outgoing=this.store.inbox('codex',this.piId,null,true);
      for(const m of outgoing.filter(m=>m.delivery==='unknown')){
        try{if(await this.codex.contains(m))this.store.mark(m.id,'submitted',{error:null});}
        catch(e){this.lastError=e.message;this.nextCodexTry=this.now()+10000;break;}
      }
      for(const m of this.store.pending(this.piId,'codex')) {
        if(this.stopped)break;
        if(m.kind==='ask'&&this.store.question(m.questionId).state!=='open'){this.store.mark(m.id,'failed',{error:'Question was closed before notification'});continue;}
        let submitted=false;
        try {
          const r=await this.codex.deliver(m,notificationText(m,this.cliPath,this.home),()=>{submitted=true;this.store.mark(m.id,'submitting');});
          if(this.stopped)break;this.store.mark(m.id,'submitted',{turnId:r.turnId});this.lastError=null;this.retryCount=0;
        }catch(e) {
          if(this.stopped)break;
          const unknown=submitted&&e.code!=='RPC_REJECTED';
          this.store.mark(m.id,unknown?'unknown':'pending',{error:e.message});this.lastError=e.message;
          this.nextCodexTry=this.now()+Math.min(60000,1000*2**Math.min(6,this.retryCount=(this.retryCount||0)+1));break;
        }
      }
    }finally{this.ticking=false;}
  }
  async stop() {
    if(this.stopped)return;this.stopped=true;clearInterval(this.timer);this.codex.close();
    for(const socket of this.clients)socket.destroy();
    if(this.server)await new Promise(resolve=>this.server.close(resolve));
    // tick may be awaiting a transport promise; closing the connection releases it.
    while(this.ticking)await new Promise(resolve=>setTimeout(resolve,10));
    const session=this.store.session(this.piId);
    if(session?.epoch===this.epoch){this.store.saveSession({...session,online:false,lastSeen:this.now()});try{unlinkSync(this.path);}catch{}}
    this.store.close();
  }
}
