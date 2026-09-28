import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {google} from 'googleapis';
const root=process.cwd();
const target='1eZEdgudWM6s5bbXAXLQfmdOvv_CO-uhRd52UCRCpiGpzvg3nF3iXH3pd';
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
async function runFunction(name) {
  const token=auth.tokens.default;
  const oauth=new google.auth.OAuth2(token.client_id,token.client_secret);
  oauth.setCredentials({
    access_token:token.access_token,
    refresh_token:token.refresh_token,
    token_type:token.token_type,
    expiry_date:token.expiry_date
  });
  const api=google.script({version:'v1',auth:oauth});
  let data;
  try {
    const response=await api.scripts.run({
      scriptId:target,
      requestBody:{function:name,parameters:[],devMode:true}
    });
    data=response.data||{};
  } catch (error) {
    const diagnostic={name:name,message:String(error?.message||''),code:error?.code||null};
    fs.writeFileSync(path.join(root,'clasp-run-output.txt'),JSON.stringify(diagnostic,null,2));
    throw Error(`Apps Script API call failed for ${name}.`);
  }
  const safe=JSON.stringify(data,null,2).replace(/ya29\.[A-Za-z0-9._-]+/g,'[REDACTED]');
  fs.writeFileSync(path.join(root,'clasp-run-output.txt'),safe);
  if(data.error) throw Error(`Apps Script function ${name} returned an execution error.`);
  if(!data.response || data.response.result===undefined) {
    throw Error(`Apps Script function ${name} returned no response.`);
  }
  console.log(`[AppsScript] ${name} completed.`);
  return data.response.result;
}
const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'crm-deploy-'));
try {
  fs.writeFileSync(authPath,JSON.stringify(auth),{mode:0o600});
  // A server-side version is a rollback checkpoint; never publish backup source as an artifact.
  run(['create-version','Before CRM deployment '+(process.env.GITHUB_SHA||'manual')]);
  run(['push','--force']);
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
  // One-time recovery/bootstrap. Create the API executable required by clasp run.
  run(['deploy','--description','CRM API executable bootstrap']);
  await runFunction('bootstrapCrmAutomation');
  console.log('Installed triggers and refreshed closed/current CRM data.');
} finally {
  fs.rmSync(authPath,{force:true});
  fs.rmSync(scratch,{recursive:true,force:true});
}
