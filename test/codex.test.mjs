import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {WebSocketServer} from 'ws';
import {once} from 'node:events';
import {mkdtempSync,rmSync} from 'node:fs';
import {CodexConnection,notificationText} from '../src/codex.mjs';
test('Unix WebSocket handshake and busy/idle delivery use proper app-server methods',async t=>{
  const home=mkdtempSync('/private/tmp/collab-ws-'),path=home+'/app.sock';const server=http.createServer(),wss=new WebSocketServer({server});let busy=true;const seen=[];
  wss.on('connection',ws=>ws.on('message',raw=>{
    const m=JSON.parse(raw);seen.push(m);if(!m.id)return;let result={};
    if(m.method==='initialize')result={userAgent:'fake-app-server'};
    if(m.method==='thread/loaded/list')result={data:['codex']};
    if(m.method==='thread/read')result={thread:{id:'codex',status:{type:busy?'active':'idle'}}};
    if(m.method==='thread/turns/list')result={data:[{id:'active-turn',status:'inProgress'}]};
    if(m.method==='turn/steer'){assert.equal(m.params.expectedTurnId,'active-turn');result={turnId:'active-turn'};}
    if(m.method==='turn/start')result={turn:{id:'new-turn'}};
    if(m.method==='thread/items/list')result={data:[{item:{content:[{text:'[pi-collab:event:event-1]'}]}}],nextCursor:null};
    ws.send(JSON.stringify({id:m.id,result}));
  }));server.listen(path);await once(server,'listening');
  const client=new CodexConnection(path);t.after(async()=>{client.close();for(const ws of wss.clients)ws.terminate();await new Promise(r=>wss.close(r));await new Promise(r=>server.close(r));rmSync(home,{recursive:true,force:true});});
  const message={id:'event-1',threadId:'codex',piId:'pi',taskId:'task',attempt:1,kind:'ask',questionId:'q'};let begins=0;
  const text=notificationText(message,"/path/with space/cli's.mjs",home);assert.match(text,/question/);assert.match(text,/event:event-1/);
  assert.equal((await client.deliver(message,text,()=>begins++)).method,'turn/steer');busy=false;
  assert.equal((await client.deliver({...message,id:'event-2'},text,()=>begins++)).method,'turn/start');assert.equal(begins,2);
  assert.equal(await client.contains(message),true);assert.equal(seen.filter(m=>m.method==='initialize').length,1);
  assert.ok(!seen.some(m=>m.method==='turn/interrupt'));
});
