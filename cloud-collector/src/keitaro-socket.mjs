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
