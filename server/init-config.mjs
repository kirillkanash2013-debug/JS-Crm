import {writeFile} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
const domain=process.argv[2];if(!domain||!/^([a-z0-9-]+\.)+[a-z]{2,}$/i.test(domain))throw new Error('Supply public domain');
await writeFile('.env','COLLECTOR_DOMAIN='+domain+'\nVAULT_KEY='+randomBytes(32).toString('base64')+'\n',{mode:0o600,flag:'wx'});
console.log('Created .env; existing keys are never overwritten.');
