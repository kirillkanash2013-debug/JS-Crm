import http from 'node:http';
import {timingSafeEqual} from 'node:crypto';
import {validateConnection} from './service.mjs';
import {publicProxy} from './proxy.mjs';
import {period} from '../extension/core.mjs';
import {collect} from './collector.mjs';
import {chromium} from 'playwright';
const secret=process.env.INTERNAL_KEY;if(!secret||secret.length<32)throw new Error('Missing INTERNAL_KEY');
let busy=false;
const auth=value=>{const expected=Buffer.from('Bearer '+secret),actual=Buffer.from(value||'');return actual.length===expected.length&&timingSafeEqual(actual,expected);};
http.createServer(async(req,res)=>{
 const send=(status,b)=>{res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(b));};
 if(req.method==='GET'&&req.url==='/health')return send(200,{ok:true,busy});
 if(!auth(req.headers.authorization))return send(401,{error:'unauthorized'});
 if(req.method!=='POST'||!['/validate','/collect','/smoke'].includes(req.url))return send(404,{error:'not_found'});
 if(busy)return send(409,{code:'busy'});
 try{let bytes=0,text='';for await(const chunk of req){bytes+=chunk.length;if(bytes>4*1024*1024){send(413,{code:'too_large'});req.destroy();return;}text+=chunk;}const b=JSON.parse(text);
  if(req.url==='/smoke'){busy=true;let browser;try{browser=await chromium.launch({headless:true});const page=await browser.newPage();await page.goto('data:text/html,<title>JS Control cloud smoke</title>');const title=await page.title();if(title!=='JS Control cloud smoke')throw new Error();return send(200,{ok:true,source:'cloudflare-browser-smoke',facebookVerified:false,browserVersion:browser.version(),observedAt:new Date().toISOString()});}finally{if(browser)await browser.close();busy=false;}}
  if(req.url==='/validate'){const c=validateConnection(b);c.proxy=await publicProxy(c.proxy);return send(200,c);}
  const c=validateConnection(b.connection);c.proxy=await publicProxy(c.proxy);
  if(b.connection.storageState)c.storageState=b.connection.storageState;
  const range=period(b.range.since,b.range.until);busy=true;
  try{return send(200,await collect(c,range,{timeoutMs:13*60000}));}finally{busy=false;}
 }catch(e){return send(400,{code:[190,102,'identity','needs_auth'].includes(e.code)?e.code:'collector_failed'});}
}).listen(8080,'0.0.0.0');
