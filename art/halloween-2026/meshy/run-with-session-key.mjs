// The key stays in memory; the localhost credential broker is supplied by the current session.
import net from 'node:net';
const [port,nonce,mode,batch]=process.argv.slice(2);
const key=await new Promise((resolve,reject)=>{
 const socket=net.connect(Number(port),'127.0.0.1',()=>socket.write(nonce)),chunks=[];
 socket.on('data',c=>chunks.push(c));socket.on('end',()=>resolve(Buffer.concat(chunks).toString()));socket.on('error',reject);
});
if(!key.startsWith('msy_'))throw Error('Missing session credential');
process.env.MESHY_API_KEY=key;
process.argv=[process.argv[0],process.argv[1],mode,batch];
await import('./meshy-workflow.mjs');
delete process.env.MESHY_API_KEY;
