// Optional local development bridge using the exact production Worker handler.
// No server-side sessions or disk credentials. Not a production server.
import http from 'node:http';
import {stat} from 'node:fs/promises';
const moduleUrl = new URL('../worker/index.js',import.meta.url);
http.createServer(async(req,res)=>{
  const path=new URL(req.url || '/', 'http://127.0.0.1:5188').pathname;
  if(req.headers.host!=='127.0.0.1:5188' || !['/weibo','/weibo-image'].includes(path)){res.writeHead(404);res.end();return;}
  const origin=req.headers.origin||'';
  if(!(path==='/weibo-image'&&!origin) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)){res.writeHead(403);res.end();return;}
  if(req.method==='OPTIONS'){res.writeHead(204,{'Access-Control-Allow-Origin':origin,'Access-Control-Allow-Headers':'Content-Type','Access-Control-Allow-Methods':'POST, OPTIONS','Vary':'Origin'});res.end();return;}
  let body='';for await(const chunk of req){body+=chunk;if(body.length>28000){res.writeHead(413);res.end();return;}}
  try{
    // Reload the same standalone source used by Cloudflare; no credentials live in this process.
    const {default:handler}=await import(moduleUrl.href+'?v='+(await stat(moduleUrl)).mtimeMs);
    const request=new Request('http://127.0.0.1:5188'+req.url,{method:req.method,headers:{Origin:origin,'Content-Type':req.headers['content-type']||''},body:req.method==='POST'?body:undefined});
    const response=await handler.fetch(request,{},{});
    res.writeHead(response.status,Object.fromEntries(response.headers.entries()));res.end(Buffer.from(await response.arrayBuffer()));
  }catch{res.writeHead(502);res.end('{"error":"Local bridge unavailable"}');}
}).listen(5188,'127.0.0.1',()=>console.log('Weibo development proxy: http://127.0.0.1:5188'));
