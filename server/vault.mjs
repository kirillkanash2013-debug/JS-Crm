import {readFile,mkdir,writeFile,rename} from 'node:fs/promises';
import {createCipheriv,createDecipheriv,randomBytes,createHash} from 'node:crypto';
export const hash=v=>createHash('sha256').update(v).digest('hex');
export class Vault {
 constructor(dir,key){this.dir=dir;this.key=Buffer.from(key||'','base64');if(this.key.length!==32)throw new Error('VAULT_KEY must be 32 bytes base64');this.data={tenants:{}};this.queue=Promise.resolve();}
 async open(){await mkdir(this.dir,{recursive:true,mode:0o700});try{const b=await readFile(this.dir+'/vault.bin');const d=createDecipheriv('aes-256-gcm',this.key,b.subarray(0,12));d.setAuthTag(b.subarray(12,28));this.data=JSON.parse(Buffer.concat([d.update(b.subarray(28)),d.final()]));}catch(e){if(e.code!=='ENOENT')throw new Error('Cannot decrypt vault');}return this;}
 async save(){const plain=JSON.stringify(this.data);this.queue=this.queue.then(async()=>{const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',this.key,iv),cipher=Buffer.concat([c.update(plain),c.final()]);await writeFile(this.dir+'/vault.tmp',Buffer.concat([iv,c.getAuthTag(),cipher]),{mode:0o600});await rename(this.dir+'/vault.tmp',this.dir+'/vault.bin');});return this.queue;}
}
