import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
const root=process.cwd();
const target='1eZEdgudWM6s5bbXAXLQfmdOvv_CO-uhRd52UCRCpiGpzvg3nF3iXH3pd';
if(JSON.parse(fs.readFileSync('.clasp.json')).scriptId!==target) throw Error('Wrong target');
if(!process.env.CLASP_AUTH_JSON) throw Error('Owner action required: add CLASP_AUTH_JSON to GitHub Actions secrets.');
const authValue=process.env.CLASP_AUTH_JSON.trim();
let auth;
try {
  auth=JSON.parse(authValue);
} catch {
  try {
    auth=JSON.parse(Buffer.from(authValue,'base64').toString('utf8'));
  } catch {
    throw Error('CLASP_AUTH_JSON must contain valid clasp JSON or its single-line Base64 encoding.');
  }
}
if(!auth.tokens?.default?.refresh_token) throw Error('Expected clasp 3 default login credentials');
const authPath=path.join(os.homedir(),'.clasprc.json');
if(fs.existsSync(authPath)) throw Error('Refusing to overwrite existing credentials; use a clean runner');
const clasp=path.join(root,'node_modules/.bin/clasp');
function run(args,cwd=root) {
  try{return execFileSync(clasp,args,{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']});}
  catch {throw Error(`clasp ${args[0]} failed; private response suppressed. Check Google authorization/API access.`);}
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
  console.log('Verified Apps Script source readback. No functions run and no triggers installed.');
} finally {
  fs.rmSync(authPath,{force:true});
  fs.rmSync(scratch,{recursive:true,force:true});
}
