import http from 'node:http';
import https from 'node:https';
import {lookup} from 'node:dns/promises';
import {publicIPv4} from './proxy.mjs';

// Pin public DNS and do not follow redirects with a user's key.
export async function checkKeitaroNode(origin,key,{resolve=lookup,request}={}) {
 try {
  const u=new URL(origin);
  if(!['http:','https:'].includes(u.protocol)||u.username||u.password||u.pathname!=='/'||u.search||u.hash)return {result:'unreachable',reason:'invalid_address'};
  if(typeof key!=='string'||key.length>4096||/[\r\n]/.test(key))return {result:'bad_key'};
  const ips=await resolve(u.hostname,{all:true,family:4});
  if(!ips.length||ips.some(a=>!publicIPv4(a.address)))return {result:'unreachable',reason:'private_address'};
  const transport=request||(u.protocol==='https:'?https.request:http.request);
  return await new Promise(done=>{
   const req=transport(new URL('/admin_api/v1/campaigns',u),{
    method:'GET',headers:{'Api-Key':key,Accept:'application/json'},
    lookup:(_host,opts,cb)=>opts.all?cb(null,[ips[0]]):cb(null,ips[0].address,4)
   },res=>{
    let bytes=0,body='';
    res.on('data',chunk=>{bytes+=chunk.length;if(bytes>4*1024*1024){req.destroy();done({result:'unreachable',reason:'too_large'});}else body+=chunk;});
    res.on('error',()=>done({result:'unreachable',reason:'network'}));
    res.on('end',()=>{
     const status=res.statusCode;
     if(status===401)return done({result:'bad_key',status});
     if(status===403)return done({result:'forbidden',status,reason:/cloudflare|error code: 1003/i.test(body)?'cloudflare':'access_denied'});
     if(status<200||status>=300)return done({result:'unreachable',status,reason:status>=300&&status<400?'redirect':'http'});
     try{const d=JSON.parse(body);const rows=Array.isArray(d)?d:Array.isArray(d?.data)?d.data:d?.campaigns;
      done(Array.isArray(rows)?{result:'ok',status,campaigns:rows.length}:{result:'unreachable',status,reason:'unexpected_response'});
     }catch{done({result:'unreachable',status,reason:'unexpected_response'});}
    });
   });
   req.setTimeout(12000,()=>req.destroy());
   const deadline=setTimeout(()=>req.destroy(),15000);
   req.on('close',()=>clearTimeout(deadline));
   req.on('error',e=>done({result:'unreachable',reason:'network',networkCode:['ETIMEDOUT','ECONNREFUSED','ECONNRESET','ENETUNREACH','EHOSTUNREACH'].includes(e.code)?e.code:'other'}));
   req.end();
  });
 }catch{return {result:'unreachable',reason:'network'};}
}
