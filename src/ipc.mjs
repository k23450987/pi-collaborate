import net from 'node:net';
import { CollabError } from './store.mjs';
export const MAX_FRAME=1024*1024;
export function call(socketPath,request,{timeoutMs=15000}={}) {
  return new Promise((resolve,reject)=>{
    const socket=net.connect(socketPath);let data='';
    socket.setEncoding('utf8');socket.setTimeout(timeoutMs,()=>socket.destroy(new CollabError('IPC_TIMEOUT','No IPC response; query the same requestId before retrying')));
    socket.on('connect',()=>socket.write(JSON.stringify(request)+'\n'));
    socket.on('data',chunk=>{
      data+=chunk;if(Buffer.byteLength(data)>MAX_FRAME){socket.destroy(new CollabError('FRAME_TOO_LARGE','IPC response exceeds limit'));return;}
      if(!data.includes('\n'))return;
      try{
        const r=JSON.parse(data.split('\n')[0]);socket.end();socket.destroy();
        if(r.ok)resolve(r.result);else reject(new CollabError(r.code||'IPC_ERROR',r.error));
      }catch(e){socket.destroy();reject(e);}
    });
    socket.on('error',reject);socket.on('end',()=>{if(!data.includes('\n'))reject(new CollabError('IPC_UNKNOWN','Connection ended before response'));});
  });
}
