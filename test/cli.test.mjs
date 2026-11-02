import {test} from 'node:test';
import assert from 'node:assert/strict';
import {copyFileSync,mkdirSync,mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {Store} from '../src/store.mjs';
import {notificationText} from '../src/codex.mjs';

const exec=promisify(execFile);
test('extensionless CLI runs standalone and notification commands survive spaces and quotes',async t=>{
  const root=mkdtempSync("/private/tmp/collab cli's-");
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const home=join(root,'state'),directory=join(root,"tool's directory");mkdirSync(directory);
  const cli=join(directory,'pi-collab');
  copyFileSync(fileURLToPath(new URL('../bin/pi-collab',import.meta.url)),cli);
  const help=await exec(cli,['--help'],{cwd:'/private/tmp'});
  assert.match(help.stdout,/Usage: pi-collab/);
  const empty=await exec(cli,['list','--home',home],{cwd:'/private/tmp'});
  assert.deepEqual(JSON.parse(empty.stdout),{ok:true,sessions:[]});

  const store=new Store(home);t.after(()=>store.close());
  store.saveSession({id:'pi',online:true});
  const codex={actor:'codex',piId:'pi',threadId:'codex'};
  store.execute({action:'bind',requestId:'bind'},codex);
  const task=store.execute({action:'start',requestId:'task',text:'read-only task'},codex);
  store.reservePi(task.message.id);
  const question=store.execute({action:'ask',taskId:task.task.id,requestId:'ask',text:'Need an answer'}, {actor:'pi',piId:'pi'});
  const notification=notificationText(question.message,cli,home);
  const read=notification.split('\n').find(line=>line.startsWith('请先读取：')).slice('请先读取：'.length);
  const received=await exec('/bin/sh',['-c',read],{cwd:'/private/tmp'});
  assert.equal(JSON.parse(received.stdout).message.id,question.message.id);
  const legacy=await exec(process.execPath,[fileURLToPath(new URL('../bin/pi-collab.mjs',import.meta.url)),'read','--home',home,'--thread','codex','--message',question.message.id]);
  assert.equal(JSON.parse(legacy.stdout).message.id,question.message.id);
});
