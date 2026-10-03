import http from 'node:http';
import {Vault} from './vault.mjs';
import {Service} from './service.mjs';
import {collect} from './collector.mjs';
export async function start({vault,collector=collect,port=8080,host='127.0.0.1',simulation=false}={}){
 const service=new Service(vault,collector,{simulation});await service.recover();
 const server=http.createServer(async(req,res)=>{
  const send=(status,value)=>{res.writeHead(status,{'content-type':'application/json','cache-control':'no-store','x-content-type-options':'nosniff'});res.end(JSON.stringify(value));};
  const url=new URL(req.url,'http://localhost');
  if(req.method==='GET'&&url.pathname==='/health')return send(200,{ok:true,service:'js-control-server',mode:simulation?'simulation':'live'});
  const tenant=service.authenticate(req.headers.authorization?.replace(/^Bearer /,''));if(!tenant)return send(401,{error:'unauthorized'});
  if(req.method==='GET'&&url.pathname==='/v1/status')return send(200,service.status(tenant));
  try{
   if(!['POST','DELETE'].includes(req.method))return send(404,{error:'not_found'});
   if(!req.headers['content-type']?.startsWith('application/json'))return send(415,{error:'json_required'});
   let bytes=0,body='';for await(const chunk of req){bytes+=chunk.length;if(bytes>256000){send(413,{error:'too_large'});req.destroy();return;}body+=chunk;}
   const b=JSON.parse(body);
   if(req.method==='POST'&&url.pathname==='/v1/connections')return send(201,await service.connect(tenant,b));
   if(req.method==='POST'&&url.pathname==='/v1/jobs')return send(202,await service.enqueue(tenant,b));
   if(req.method==='POST'&&url.pathname==='/v1/schedule'){
    const c=tenant.connections[b.userId];if(!c)throw new Error();if(!Number.isInteger(b.minutes)||b.minutes<0||b.minutes>1440||(b.minutes>0&&b.minutes<15))throw new Error();
    c.schedule=b.minutes?{minutes:b.minutes,nextAt:Date.now()+b.minutes*60000}:null;await vault.save();return send(200,{ok:true});
   }
   if(req.method==='DELETE'&&url.pathname==='/v1/connections'){
    delete tenant.connections[b.userId];delete tenant.results[b.userId];for(const j of tenant.jobs)if(j.userId===b.userId&&j.state==='queued')j.state='cancelled';await vault.save();return send(200,{ok:true});
   }
   return send(404,{error:'not_found'});
  }catch{return send(400,{error:'invalid_request'});}
 });server.requestTimeout=30000;server.headersTimeout=15000;
 await new Promise(resolve=>server.listen(port,host,resolve));const timer=setInterval(()=>void service.tick().catch(()=>{}),1000);timer.unref();
 return {server,service,close:async()=>{clearInterval(timer);service.stopping=true;await new Promise(r=>server.close(r));while(service.running)await new Promise(r=>setTimeout(r,100));}};
}
if(process.argv[1]===new URL(import.meta.url).pathname){const vault=await new Vault(process.env.DATA_DIR||'./data',process.env.VAULT_KEY).open();await start({vault,port:Number(process.env.PORT||8080),host:process.env.HOST||'127.0.0.1'});console.log('JS Control server ready');}
