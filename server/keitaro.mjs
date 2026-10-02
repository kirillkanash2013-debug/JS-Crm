import http from 'node:http';
import https from 'node:https';
import {lookup} from 'node:dns/promises';
import {publicIPv4} from './proxy.mjs';
import {profileTimezone} from './keitaro-timezone.mjs';

// Pin public DNS and do not follow redirects with a user's key.
async function keitaroNodeGet(origin,key,{resolve=lookup,request}={},profile=false) {
 try {
  const u=new URL(origin);
  if(!['http:','https:'].includes(u.protocol)||u.username||u.password||u.pathname!=='/'||u.search||u.hash)return {result:'unreachable',reason:'invalid_address'};
  if(typeof key!=='string'||key.length>4096||/[\r\n]/.test(key))return {result:'bad_key'};
  const ips=await resolve(u.hostname,{all:true,family:4});
  if(!ips.length||ips.some(a=>!publicIPv4(a.address)))return {result:'unreachable',reason:'private_address'};
  const transport=request||(u.protocol==='https:'?https.request:http.request);
  return await new Promise(done=>{
   const req=transport(new URL(profile?'/admin/?object=profile.show':'/admin_api/v1/campaigns',u),{
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
     try{const d=JSON.parse(body);if(profile)return done({result:'ok',timezone:profileTimezone(d)});const rows=Array.isArray(d)?d:Array.isArray(d?.data)?d.data:d?.campaigns;
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

// One JSON POST to Keitaro's admin API with pinned public DNS, no redirects.
function keitaroNodePost(u,ips,key,path,payload,transport){
 return new Promise(done=>{
  const bodyStr=JSON.stringify(payload||{});
  const req=transport(new URL(path,u),{
   method:'POST',
   headers:{'Api-Key':key,Accept:'application/json','Content-Type':'application/json','Content-Length':Buffer.byteLength(bodyStr)},
   lookup:(_host,opts,cb)=>opts.all?cb(null,[ips[0]]):cb(null,ips[0].address,4)
  },res=>{
   let bytes=0,body='';
   res.on('data',chunk=>{bytes+=chunk.length;if(bytes>16*1024*1024){req.destroy();done({result:'unreachable',reason:'too_large'});}else body+=chunk;});
   res.on('error',()=>done({result:'unreachable',reason:'network'}));
   res.on('end',()=>{
    const status=res.statusCode;
    if(status===401)return done({result:'bad_key',status});
    if(status===403)return done({result:'forbidden',status,reason:'access_denied'});
    if(status<200||status>=300)return done({result:'unreachable',status,reason:'http'});
    try{done({result:'ok',status,json:JSON.parse(body)});}catch{done({result:'unreachable',status,reason:'unexpected_response'});}
   });
  });
  req.setTimeout(20000,()=>req.destroy());
  req.on('error',()=>done({result:'unreachable',reason:'network'}));
  req.write(bodyStr);req.end();
 });
}

const normalizeRows=raw=>Array.isArray(raw)?raw:Array.isArray(raw?.rows)?raw.rows:Array.isArray(raw?.data)?raw.data:Array.isArray(raw?.data?.rows)?raw.data.rows:[];

// Keitaro report via the container (proxy fallback when the Worker socket fails).
// Returns the same raw {report,conversions} shape as reportKeitaroSocket.
export async function reportKeitaroNode(origin,key,{from,to,timezone,subIndex}={},{resolve=lookup,request}={}) {
 try{
  const u=new URL(origin);
  if(!['http:','https:'].includes(u.protocol)||u.username||u.password||u.pathname!=='/'||u.search||u.hash)return {result:'unreachable',reason:'invalid_address'};
  if(typeof key!=='string'||key.length>4096||/[\r\n]/.test(key))return {result:'bad_key'};
  const ips=await resolve(u.hostname,{all:true,family:4});
  if(!ips.length||ips.some(a=>!publicIPv4(a.address)))return {result:'unreachable',reason:'private_address'};
  const transport=request||(u.protocol==='https:'?https.request:http.request);
  const sub='sub_id_'+(subIndex||4);
  const build=await keitaroNodePost(u,ips,key,'/admin_api/v1/report/build',{
   range:{from,to,timezone},
   columns:['campaign_id','campaign',sub,'offer'],
   metrics:['clicks','campaign_unique_clicks','conversions','sales','sale_revenue'],
   grouping:['campaign_id','campaign',sub,'offer'],filters:[]
  },transport);
  if(build.result!=='ok')return build;
  const log=await keitaroNodePost(u,ips,key,'/admin_api/v1/conversions/log',{
   range:{from,to,timezone},limit:10000,offset:0,
   columns:['conversion_id','sub_id','campaign_id','campaign','offer','revenue','status','click_datetime','postback_datetime',sub],
   filters:[],sort:[{name:'postback_datetime',order:'ASC'},{name:'conversion_id',order:'ASC'}]
  },transport);
  if(log.result!=='ok')return log;
  return {result:'ok',report:normalizeRows(build.json),conversions:normalizeRows(log.json)};
 }catch{return {result:'unreachable',reason:'network'};}
}

export const checkKeitaroNode = (origin,key,options) => keitaroNodeGet(origin,key,options);
// profile.show is the current-user UI read command observed in Keitaro Network.
// API-key access is version-dependent and is not guaranteed by the public
// Admin API spec. An unavailable profile must fall back to explicit user input.
export const timezoneKeitaroNode = (origin,key,options) => keitaroNodeGet(origin,key,options,true);
