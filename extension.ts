import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Text, visibleWidth } from '@earendil-works/pi-tui';
import { Type } from 'typebox';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripVTControlCharacters } from 'node:util';
import { Runtime } from './src/runtime.mjs';
import { stateHome } from './src/paths.mjs';
import { waitFor } from './src/wait.mjs';

const cliPath=fileURLToPath(new URL('./bin/pi-collab',import.meta.url));
const Actions=['send','ask','reply','report','status','inbox','read','ack'] as const;
const Params=Type.Object({
  action:Type.Union(Actions.map(v=>Type.Literal(v))),
  taskId:Type.Optional(Type.String()),text:Type.Optional(Type.String()),
  questionId:Type.Optional(Type.String()),messageId:Type.Optional(Type.String()),
  state:Type.Optional(Type.Union(['running','blocked','completed','failed','cancelled'].map(v=>Type.Literal(v)))),
  version:Type.Optional(Type.Integer({minimum:1})),requestId:Type.Optional(Type.String()),
  after:Type.Optional(Type.String()),limit:Type.Optional(Type.Integer({minimum:1,maximum:100})),
  waitMs:Type.Optional(Type.Integer({minimum:0,maximum:2147483647})),
  delivery:Type.Optional(Type.Union([Type.Literal('steer'),Type.Literal('followUp')])),
});

export default function(pi:ExtensionAPI) {
  let runtime:Runtime|undefined;let context:any;
  let lifecycle=Promise.resolve();
  pi.registerMessageRenderer('pi-collaborate',(message,{expanded},theme)=>{
    const m:any=message.details;const label=`From: Codex ${m?.threadId?.slice(0,8)||''} · ${m?.kind||'message'}`;
    const text=stripVTControlCharacters(String(message.content));const lines=text.split('\n');
    const body=expanded?text:lines.slice(0,6).join('\n')+(lines.length>6?'\n… 展开查看全文':'');
    const info=expanded?`\n\ntask: ${m?.taskId} · attempt: ${m?.attempt}\nmessage: ${m?.id}${m?.questionId?'\nquestion: '+m.questionId:''}`:'';
    const component=new Text(body+info,0,0);
    return {
      invalidate(){component.invalidate();},
      render(width:number){
        if(width<8)return component.render(width);
        const inner=component.render(width-4);const header=new Text(label,0,0).render(width-4)[0]||'';
        const border=(s:string)=>theme.fg('border',s);
        const row=(s:string)=>border('│ ')+s+' '.repeat(Math.max(0,width-4-visibleWidth(s)))+border(' │');
        return [border('╭'+'─'.repeat(width-2)+'╮'),row(theme.fg('accent',header)),...inner.map(row),border('╰'+'─'.repeat(width-2)+'╯')];
      },
    };
  });
  pi.registerTool({
    name:'collaborate',label:'Collaborate',
    description:'Communicate with the bound Codex coordinator. Always specify taskId; reply only accepts questionId from ask. report explicitly commits running/blocked/completed/failed/cancelled. Ordinary text is not task completion. read does not ack. ask waiting can time out without closing its persistent question.',
    parameters:Params,
    async execute(toolCallId,params,signal){
      if(!runtime)throw new Error('Pi Collaborate is not running in this session');
      const input={...params,requestId:params.requestId||toolCallId};
      const result:any=runtime.execute(input);
      const wait=params.action==='ask'?await waitFor(runtime.store,{questionId:result.question.id,waitMs:params.waitMs??600000,signal}):undefined;
      const data={...result,...(wait?{wait}:{})};
      return {content:[{type:'text',text:JSON.stringify(data)}],details:data};
    },
  });
  pi.registerCommand('collaborate',{
    description:'Show session binding, tasks and uncollected inbox',
    handler:async(_args,ctx)=>{
      if(!runtime){ctx.ui.notify('Pi Collaborate 未启动','warning');return;}
      const session=runtime.store.session(runtime.piId);const tasks=runtime.store.tasks(runtime.piId);
      const text=JSON.stringify({session,tasks,inbox:runtime.execute({action:'inbox'}),appServerError:runtime.lastError},null,2);
      pi.sendMessage({customType:'pi-collaborate',content:text,display:true,details:{kind:'status',threadId:session?.threadId}});
    },
  });
  pi.on('session_start',(_event,ctx)=>{
    lifecycle=lifecycle.then(async()=>{
      if(runtime)await runtime.stop();runtime=undefined;context=ctx;
      const home=stateHome();const configFile=join(home,'config.json');
      const config=existsSync(configFile)?JSON.parse(readFileSync(configFile,'utf8')):{};
      const ids=new Set<string>();
      for(const entry of ctx.sessionManager.getBranch()){
        const e:any=entry;if(e.type==='custom_message'&&e.customType==='pi-collaborate'&&e.details?.id)ids.add(e.details.id);
      }
      const current=new Runtime({home,piId:ctx.sessionManager.getSessionId(),name:pi.getSessionName(),cwd:ctx.cwd,cliPath,visibleIds:ids,config,
        deliver:async(m:any)=>{
          const hint=m.kind==='task'?`\n\n请执行任务；使用 collaborate report 显式报告结果。taskId=${m.taskId}`:m.kind==='ask'?`\n\n请用 collaborate reply 回答 questionId=${m.questionId}`:'';
          pi.sendMessage({customType:'pi-collaborate',content:m.text+hint,display:true,details:m},ctx.isIdle()?{triggerTurn:true}:{deliverAs:m.deliveryMode==='followUp'?'followUp':'steer'});
        },
      });
      current.canFollowUp=()=>context?.isIdle()&&!context?.hasPendingMessages();
      try{await current.start();runtime=current;ctx.ui.setStatus('pi-collaborate',`collab ${current.piId.slice(0,8)}`);}
      catch(e){await current.stop();ctx.ui.notify(`Pi Collaborate: ${(e as Error).message}`,'error');}
    });return lifecycle;
  });
  pi.on('session_shutdown',()=>{
    lifecycle=lifecycle.then(async()=>{const old=runtime;runtime=undefined;context=undefined;await old?.stop();});return lifecycle;
  });
  pi.on('agent_settled',async()=>{await runtime?.tick();});
}
