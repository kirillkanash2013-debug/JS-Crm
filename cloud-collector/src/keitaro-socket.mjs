import {readResponse} from './proxy-fetch.mjs';
export function publicIP(host){
 if(!/^\d+\.\d+\.\d+\.\d+$/.test(host))return false;
 const [a,b,...rest]=host.split('.').map(Number);
 return [a,b,...rest].every(n=>n>=0&&n<=255)&&!(a===0||a===10||a===127||a>=224||a===169&&b===254||a===172&&b>=16&&b<=31||a===192&&(b===168||b===0)||a===100&&b>=64&&b<=127||a===198&&(b===18||b===19));
}
export async function checkKeitaroSocket(origin,key,connect){
 let socket,timer;
 try {
  const u=new URL(origin);
  if(!publicIP(u.hostname)||!['http:','https:'].includes(u.protocol)||u.username||u.password||u.pathname!=='/'||u.search||u.hash)return {result:'unreachable',reason:'invalid_address',transport:'socket'};
  if(typeof key!=='string'||key.length>4096||/[\r\n]/.test(key))return {result:'bad_key',transport:'socket'};
  socket=connect({hostname:u.hostname,port:Number(u.port)||(u.protocol==='https:'?443:80)},{secureTransport:u.protocol==='https:'?'on':'off'});
  return await Promise.race([
   (async()=>{
    await socket.opened;
    const w=socket.writable.getWriter();
    try{await w.write(new TextEncoder().encode('GET /admin_api/v1/campaigns HTTP/1.1\r\nHost: '+u.host+'\r\nApi-Key: '+key+'\r\nAccept: application/json\r\nAccept-Encoding: identity\r\nConnection: close\r\n\r\n'));}finally{w.releaseLock();}
    const {status,body}=await readResponse(socket);
    if(status===401)return {result:'bad_key',status,transport:'socket'};
    if(status===403)return {result:'forbidden',status,reason:'access_denied',transport:'socket'};
    if(status<200||status>=300)return {result:'unreachable',status,reason:'http',transport:'socket'};
    const d=JSON.parse(new TextDecoder().decode(body)),rows=Array.isArray(d)?d:Array.isArray(d?.data)?d.data:d?.campaigns;
    return Array.isArray(rows)?{result:'ok',status,campaigns:rows.length,transport:'socket'}:{result:'unreachable',status,reason:'unexpected_response',transport:'socket'};
   })(),
   new Promise(resolve=>{timer=setTimeout(()=>resolve({result:'unreachable',reason:'timeout',transport:'socket'}),12000);})
  ]);
 }catch{return {result:'unreachable',reason:'network',transport:'socket'};}
 finally{clearTimeout(timer);try{await socket?.close();}catch{}}
}

// One JSON POST to Keitaro's admin API over a raw socket (bypasses the tracker's
// datacenter-IP block, same transport as the reachability check). `Connection:
// close` means one request per socket, so report/build and conversions/log each
// open their own. Returns {result:'ok',status,json} or an error shape.
async function socketPost(origin,key,path,payload,connect){
 let socket,timer;
 try{
  const u=new URL(origin);
  if(!publicIP(u.hostname)||!['http:','https:'].includes(u.protocol))return {result:'unreachable',reason:'invalid_address'};
  const bodyBytes=new TextEncoder().encode(JSON.stringify(payload||{}));
  socket=connect({hostname:u.hostname,port:Number(u.port)||(u.protocol==='https:'?443:80)},{secureTransport:u.protocol==='https:'?'on':'off'});
  return await Promise.race([
   (async()=>{
    await socket.opened;
    const w=socket.writable.getWriter();
    try{
     await w.write(new TextEncoder().encode('POST '+path+' HTTP/1.1\r\nHost: '+u.host+'\r\nApi-Key: '+key+'\r\nContent-Type: application/json\r\nAccept: application/json\r\nAccept-Encoding: identity\r\nConnection: close\r\nContent-Length: '+bodyBytes.length+'\r\n\r\n'));
     await w.write(bodyBytes);
    }finally{w.releaseLock();}
    const {status,body}=await readResponse(socket);
    if(status===401)return {result:'bad_key',status};
    if(status===403)return {result:'forbidden',status,reason:'access_denied'};
    if(status<200||status>=300)return {result:'unreachable',status,reason:'http'};
    try{return {result:'ok',status,json:JSON.parse(new TextDecoder().decode(body))};}
    catch{return {result:'unreachable',status,reason:'unexpected_response'};}
   })(),
   new Promise(resolve=>{timer=setTimeout(()=>resolve({result:'unreachable',reason:'timeout'}),20000);})
  ]);
 }catch{return {result:'unreachable',reason:'network'};}
 finally{clearTimeout(timer);try{await socket?.close();}catch{}}
}

const normalizeRows=raw=>Array.isArray(raw)?raw:Array.isArray(raw?.rows)?raw.rows:Array.isArray(raw?.data)?raw.data:Array.isArray(raw?.data?.rows)?raw.data.rows:[];

// Fetches the raw rows the platform needs to build the «Сейчас» report:
// report/build (clicks/unique_clicks grouped by sub_id_4=FB campaign id) and
// conversions/log (status/revenue/click date, authoritative for reg/dep/rev).
// The platform aggregates these and joins with FB spend.
export async function reportKeitaroSocket(origin,key,{from,to,timezone,subIndex},connect){
 const sub='sub_id_'+(subIndex||4);
 const build=await socketPost(origin,key,'/admin_api/v1/report/build',{
  range:{from,to,timezone},
  columns:['campaign_id','campaign',sub,'offer'],
  metrics:['clicks','campaign_unique_clicks','conversions','sales','sale_revenue'],
  grouping:['campaign_id','campaign',sub,'offer'],
  filters:[]
 },connect);
 if(build.result!=='ok')return build;
 const log=await socketPost(origin,key,'/admin_api/v1/conversions/log',{
  range:{from,to,timezone},
  limit:10000,offset:0,
  columns:['conversion_id','sub_id','campaign_id','campaign','offer','revenue','status','click_datetime','postback_datetime',sub],
  filters:[],
  sort:[{name:'postback_datetime',order:'ASC'},{name:'conversion_id',order:'ASC'}]
 },connect);
 if(log.result!=='ok')return log;
 return {result:'ok',report:normalizeRows(build.json),conversions:normalizeRows(log.json)};
}
