import {randomBytes,randomUUID} from 'node:crypto';
import {Vault,hash} from './vault.mjs';
const vault=await new Vault(process.env.DATA_DIR||'./data',process.env.VAULT_KEY).open();
const id=randomUUID(),key='js_srv_'+randomBytes(32).toString('base64url');
vault.data.tenants[id]={id,keyHash:hash(key),connections:{},jobs:[],results:{}};await vault.save();
console.log(JSON.stringify({tenant:id,key}));
