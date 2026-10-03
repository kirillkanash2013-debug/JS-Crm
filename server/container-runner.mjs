import {applyCampaignActionApi,validateAction} from './campaign-action.mjs';
import http from 'node:http';
import {checkKeitaroNode,reportKeitaroNode,timezoneKeitaroNode} from './keitaro.mjs';
import {timingSafeEqual} from 'node:crypto';
import {validateConnection} from './service.mjs';
import {publicProxy} from './proxy.mjs';
import {period} from '../extension/core.mjs';
import {collect} from './collector.mjs';
import {apiValidate, collectViaApi} from './api-collect.mjs';
import {chromium} from 'playwright';

// Minimal validation for the proxy API path (cookies optional, unlike a full
// browser session transfer). Pins the proxy DNS to a public IPv4.
async function cleanApi(b) {
  const userId = String(b?.userId || '');
  const token = String(b?.token || '');
  if (!/^\d{3,30}$/.test(userId) || !/^EA[A-Za-z0-9_-]{18,4094}$/.test(token)) throw Object.assign(new Error('invalid'), {code: 'invalid'});
  const c = {userId, token, userAgent: String(b.userAgent || 'Mozilla/5.0'), cookies: Array.isArray(b.cookies) ? b.cookies.slice(0, 200) : [], proxy: await publicProxy(b.proxy)};
  return c;
}
const secret=process.env.INTERNAL_KEY;if(!secret||secret.length<32)throw new Error('Missing INTERNAL_KEY');
let busy=false;
const auth=value=>{const expected=Buffer.from('Bearer '+secret),actual=Buffer.from(value||'');return actual.length===expected.length&&timingSafeEqual(actual,expected);};
http.createServer(async(req,res)=>{
 const send=(status,b)=>{res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(b));};
 if(req.method==='GET'&&req.url==='/health')return send(200,{ok:true,busy});
 if(!auth(req.headers.authorization))return send(401,{error:'unauthorized'});
 if(req.method!=='POST'||!['/validate','/collect','/smoke','/action','/api-validate','/api-collect','/keitaro-check','/keitaro-report','/keitaro-timezone'].includes(req.url))return send(404,{error:'not_found'});
 // API (no-browser) endpoints run concurrently; only browser work uses the busy gate.
 const browserPath=['/validate','/collect','/smoke'].includes(req.url);
 if(browserPath&&busy)return send(409,{code:'busy'});
 try{let bytes=0,text='';for await(const chunk of req){bytes+=chunk.length;if(bytes>4*1024*1024){send(413,{code:'too_large'});req.destroy();return;}text+=chunk;}const b=JSON.parse(text);
  if(req.url==='/keitaro-timezone')return send(200,await timezoneKeitaroNode(b.origin,b.key));
  if(req.url==='/keitaro-check')return send(200,await checkKeitaroNode(b.origin,b.key));
  if(req.url==='/keitaro-report')return send(200,await reportKeitaroNode(b.origin,b.key,{from:b.from,to:b.to,timezone:b.timezone,subIndex:b.subIndex}));
  if(req.url==='/api-validate'){try{const c=await cleanApi(b);await apiValidate(c);return send(200,{userId:c.userId,token:c.token,userAgent:c.userAgent,cookies:c.cookies,proxy:c.proxy});}catch(e){return send(422,{code:e.code==='proxy'?'proxy':(typeof e.code==='number'?e.code:e.code==='identity'?'identity':'validation_failed'),detail:e.detail||e.message});}}
  if(req.url==='/api-collect'){try{const c=await cleanApi(b.connection);const range=period(b.range.since,b.range.until);return send(200,await collectViaApi(c,range,{previous:b.previous}));}catch(e){return send(400,{code:[190,102].includes(e.code)?e.code:(e.code==='proxy'?'proxy':'collector_failed'),detail:e.detail||e.message});}}
  if(req.url==='/smoke'){busy=true;let browser;try{browser=await chromium.launch({headless:true});const page=await browser.newPage();await page.goto('data:text/html,<title>JS Control cloud smoke</title>');const title=await page.title();if(title!=='JS Control cloud smoke')throw new Error();return send(200,{ok:true,source:'cloudflare-browser-smoke',facebookVerified:false,browserVersion:browser.version(),observedAt:new Date().toISOString()});}finally{if(browser)await browser.close();busy=false;}}
  if(req.url==='/validate'){const c=validateConnection(b);c.proxy=await publicProxy(c.proxy);return send(200,c);}
  const c=validateConnection(b.connection);c.proxy=await publicProxy(c.proxy);
  if(b.connection.storageState)c.storageState=b.connection.storageState;
  // Действие через Graph API в Node (сквозь прокси, включая SOCKS5 с логином) —
  // без браузера. Не грузит контейнер, работает с любым прокси.
  if(req.url==='/action'){validateAction(b.action);return send(200,await applyCampaignActionApi(c,b.action));}
  const range=period(b.range.since,b.range.until);busy=true;
  try{return send(200,await collect(c,range,{timeoutMs:13*60000}));}finally{busy=false;}
 }catch(e){return send(400,{code:[190,102,'identity','needs_auth'].includes(e.code)?e.code:'collector_failed',detail:e.detail||e.message||null});}
}).listen(8080,'0.0.0.0');
