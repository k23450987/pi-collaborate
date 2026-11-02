import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {dirname,join} from 'node:path';
import {mkdtempSync,rmSync} from 'node:fs';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {Store} from '../src/store.mjs';
const require=createRequire(import.meta.url);
let sdk=process.env.PI_SDK_PATH;
try{sdk ||= dirname(dirname(require.resolve('@earendil-works/pi-coding-agent')));}catch{}
const cwd=fileURLToPath(new URL('..',import.meta.url));

test('Pi package resource loader accepts host dependency declarations', {skip:!sdk},async t=>{
  const {DefaultResourceLoader}=await import(pathToFileURL(join(sdk,'dist/core/resource-loader.js')).href);
  const {SettingsManager}=await import(pathToFileURL(join(sdk,'dist/core/settings-manager.js')).href);
  const agentDir=mkdtempSync('/private/tmp/collab-package-');
  t.after(()=>rmSync(agentDir,{recursive:true,force:true}));
  const loader=new DefaultResourceLoader({cwd:agentDir,agentDir,
    settingsManager:SettingsManager.inMemory({packages:[cwd]}),
    noSkills:true,noPromptTemplates:true,noThemes:true,noContextFiles:true});
  await loader.reload();
  const loaded=loader.getExtensions();
  assert.deepEqual(loaded.errors,[]);
  assert.deepEqual(loaded.warnings??[],[]);
  assert.ok(loaded.extensions.some(extension=>extension.tools.has('collaborate')));
});

test('Pi loader, actual renderer and lifecycle deliver visible idle/steer cards without intercom', {skip:!sdk},async t=>{
  const {loadExtensions}=await import(pathToFileURL(join(sdk,'dist/core/extensions/loader.js')).href);
  const {visibleWidth}=await import(pathToFileURL(require.resolve('@earendil-works/pi-tui',{paths:[sdk]})).href);
  const r=await loadExtensions([join(cwd,'extension.ts')],cwd);assert.deepEqual(r.errors,[]);
  const extension=r.extensions[0],messages=[],errors=[];
  r.runtime.getSessionName=()=> 'Pi test';r.runtime.sendMessage=(message,options)=>messages.push({message,options});
  const home=mkdtempSync('/private/tmp/collab-pi-sdk-');const oldHome=process.env.PI_COLLAB_HOME,oldSocket=process.env.PI_COLLAB_CODEX_SOCKET;
  process.env.PI_COLLAB_HOME=home;process.env.PI_COLLAB_CODEX_SOCKET=home+'/not-running.sock';
  let idle=true;
  const ctx={cwd,sessionManager:{getSessionId:()=> 'pi-sdk-test',getBranch:()=>[]},isIdle:()=>idle,hasPendingMessages:()=>false,ui:{setStatus(){},notify:(...args)=>errors.push(args)}};
  const emit=async name=>{for(const h of extension.handlers.get(name)||[])await h({},ctx);};
  t.after(async()=>{await emit('session_shutdown');if(oldHome===undefined)delete process.env.PI_COLLAB_HOME;else process.env.PI_COLLAB_HOME=oldHome;if(oldSocket===undefined)delete process.env.PI_COLLAB_CODEX_SOCKET;else process.env.PI_COLLAB_CODEX_SOCKET=oldSocket;rmSync(home,{recursive:true,force:true});});
  await emit('session_start');assert.deepEqual(errors,[]);
  const store=new Store(home);t.after(()=>store.close());const c={actor:'codex',piId:'pi-sdk-test',threadId:'codex-sdk-test'};
  store.execute({action:'bind',requestId:'bind'},c);
  const start=store.execute({action:'start',requestId:'start',text:'Visible task card'},c);await emit('agent_settled');
  assert.equal(messages[0].message.customType,'pi-collaborate');assert.equal(messages[0].options.triggerTurn,true);
  idle=false;store.execute({action:'send',requestId:'correction',taskId:start.task.id,text:'Correction during busy work'},c);await emit('agent_settled');assert.equal(messages[1].options.deliverAs,'steer');
  const renderer=extension.messageRenderers.get('pi-collaborate'),theme={fg:(_color,text)=>text};
  const content=Array.from({length:12},(_,i)=>`正文第 ${i+1} 行`).join('\n')+'\n\x1b[31mno terminal escape\x1b[0m';
  const sample={...messages[0].message,content};
  const collapsed=renderer(sample,{expanded:false},theme).render(56).join('\n');
  const expanded=renderer(sample,{expanded:true},theme).render(56).join('\n');
  assert.match(collapsed,/From: Codex/);assert.match(collapsed,/展开查看全文/);assert.doesNotMatch(collapsed,/正文第 12 行/);
  assert.match(expanded,/正文第 12 行/);assert.match(expanded,/message:/);assert.ok(!expanded.includes('\x1b'));
  for(const width of [5,20,56])for(const line of renderer(sample,{expanded:true},theme).render(width))assert.ok(visibleWidth(line)<=width);
  const tool=extension.tools.get('collaborate').definition;
  const status=await tool.execute('tool-status',{action:'status',taskId:start.task.id},new AbortController().signal);assert.equal(status.details.task.status,'running');
  const asked=await tool.execute('tool-question',{action:'ask',taskId:start.task.id,text:'Need coordinator input',waitMs:0},new AbortController().signal);
  assert.equal(asked.details.wait.status,'pending');
  store.execute({action:'reply',questionId:asked.details.question.id,text:'Keep original scope',requestId:'answer'},c);
  const report=await tool.execute('tool-result',{action:'report',taskId:start.task.id,state:'completed',text:'validated'},new AbortController().signal);
  assert.equal(report.details.result.text,'validated');
});
