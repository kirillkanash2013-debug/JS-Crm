import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {OAuth2Client} from 'google-auth-library';
const root=process.cwd();
const target='1eZEdgudWM6s5bbXAXLQfmdOvv_CO-uhRd52UCRCpiGpzvg3nF3iXH3pd';
const stableTelegramDeployment='AKfycbxHwc-vrZjEkD-7V0ud6RNA4132Xma_9VyS3TvjP-I1WfyWqMpU8paTkWPHhHRuB2OycA';
if(JSON.parse(fs.readFileSync('.clasp.json')).scriptId!==target) throw Error('Wrong target');
if(!process.env.CLASP_AUTH_JSON) throw Error('Owner action required: add CLASP_AUTH_JSON to GitHub Actions secrets.');
const authValue=process.env.CLASP_AUTH_JSON.trim();
function parseAuth(value) {
  const attempts=[value];
  const firstBrace=value.indexOf('{');
  const lastBrace=value.lastIndexOf('}');
  if(firstBrace>=0&&lastBrace>firstBrace) attempts.push(value.slice(firstBrace,lastBrace+1));

  const compact=value.replace(/\s+/g,'');
  attempts.push(Buffer.from(compact,'base64').toString('utf8'));

  const encodedCandidates=value.match(/[A-Za-z0-9+/_=-]{100,}/g)||[];
  encodedCandidates.sort((a,b)=>b.length-a.length).forEach(candidate=>{
    const normalized=candidate.replace(/-/g,'+').replace(/_/g,'/');
    attempts.push(Buffer.from(normalized,'base64').toString('utf8'));
  });

  for(const candidate of attempts) {
    try {
      const parsed=JSON.parse(candidate);
      if(parsed?.tokens?.default?.refresh_token) return parsed;
    } catch {}
  }
  throw Error('CLASP_AUTH_JSON must contain valid clasp JSON or its Base64 encoding.');
}
const auth=parseAuth(authValue);
if(!auth.tokens?.default?.refresh_token) throw Error('Expected clasp 3 default login credentials');
const authPath=path.join(os.homedir(),'.clasprc.json');
if(fs.existsSync(authPath)) throw Error('Refusing to overwrite existing credentials; use a clean runner');
const clasp=path.join(root,'node_modules/.bin/clasp');
function run(args,cwd=root) {
  try{return execFileSync(clasp,args,{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']});}
  catch (error) {
    const diagnostic={args:args,code:error?.status??error?.code??null,signal:error?.signal??null,message:String(error?.message||''),stdout:String(error?.stdout||''),stderr:String(error?.stderr||'')};
    const raw=JSON.stringify(diagnostic,null,2);
    const safe=raw.replace(/ya29\.[A-Za-z0-9._-]+/g,'[REDACTED]').replace(/("(?:access_token|refresh_token|client_secret)"\s*:\s*")[^"]+/gi,'$1[REDACTED]');
    fs.writeFileSync(path.join(root,'clasp-run-output.txt'),safe.slice(0,8000));
    throw Error(`clasp ${args[0]} failed; see sanitized diagnostic artifact.`);
  }
}
async function runAppsScriptFunction(functionName) {
  const credentials=auth.tokens.default;
  const client=new OAuth2Client(credentials.client_id,credentials.client_secret);
  client.setCredentials({
    access_token:credentials.access_token,
    refresh_token:credentials.refresh_token,
    expiry_date:credentials.expiry_date
  });
  const accessToken=await client.getAccessToken();
  const response=await fetch(`https://script.googleapis.com/v1/scripts/${target}:run`,{
    method:'POST',
    headers:{
      authorization:`Bearer ${accessToken.token}`,
      'content-type':'application/json'
    },
    body:JSON.stringify({function:functionName,devMode:true})
  });
  const body=await response.json();
  if(!response.ok||body.error||body.response?.error) {
    const message=body.error?.message||body.response?.error?.details?.[0]?.errorMessage||
      `HTTP ${response.status}`;
    throw Error(`Apps Script ${functionName} failed: ${message}`);
  }
  return body.response?.result??null;
}
const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'crm-deploy-'));
try {
  fs.writeFileSync(authPath,JSON.stringify(auth),{mode:0o600});
  // A server-side version is a rollback checkpoint; never publish backup source as an artifact.
  run(['create-version','Before CRM deployment '+(process.env.GITHUB_SHA||'manual')]);
  run(['push','--force']);
  const deployOutput=run(['deploy','--deploymentId',stableTelegramDeployment,
    '--description','CRM '+(process.env.GITHUB_SHA||'manual')]);
  console.log('Updated stable Apps Script deployment: '+deployOutput.trim().replace(/https?:\/\/\S+/g,'[URL REDACTED]'));
  // Re-register Telegram immediately. This prevents a stale webhook from
  // leaving commands unanswered until the next time-based trigger fires.
  const telegramRepair=await runAppsScriptFunction('repairTelegramWebhook');
  console.log('Telegram webhook repair verified: '+JSON.stringify(telegramRepair));
  const telegramRoundTrip=await runAppsScriptFunction('testTelegramWebhookRoundTrip');
  console.log('Telegram webhook round-trip verified: '+JSON.stringify(telegramRoundTrip));
  fs.writeFileSync(path.join(scratch,'.clasp.json'),JSON.stringify({scriptId:target,rootDir:'.',scriptExtensions:['.js'],htmlExtensions:['.html'],jsonExtensions:['.json']}));
  run(['pull'],scratch);
  const expected=fs.readFileSync('.claspignore','utf8').split('\n').filter(x=>x.startsWith('!')).map(x=>x.slice(1));
  for(const file of expected) {
    const local=fs.readFileSync(path.join(root,file),'utf8');
    const remote=fs.readFileSync(path.join(scratch,file),'utf8');
    const norm=s=>s.replace(/\r\n/g,'\n').trim();
    if(file.endsWith('.json')) {
      if(JSON.stringify(JSON.parse(local))!==JSON.stringify(JSON.parse(remote))) throw Error('Manifest readback mismatch');
    } else if(norm(local)!==norm(remote)) throw Error('Source readback mismatch: '+file);
  }
  const extra=fs.readdirSync(scratch).filter(x=>/\.(js|gs|html)$/.test(x)&&!expected.includes(x));
  if(extra.length)throw Error('Unexpected remote modules after deployment');
  console.log('Verified Apps Script source readback.');
} finally {
  fs.rmSync(authPath,{force:true});
  fs.rmSync(scratch,{recursive:true,force:true});
}
