// Wrangler entry for the platform Worker. Kept separate from index.mjs so that
// index.mjs stays importable by node tests (this file imports cloudflare:workers,
// which node cannot resolve). It re-exports the HTTP worker unchanged and adds
// the BotNotify service entrypoint the collector calls on a new connection.
import {WorkerEntrypoint} from 'cloudflare:workers';
import {createBot} from './bot.mjs';
import {containerKeitaro} from './keitaro.mjs';
import {D1Store} from './store.mjs';
import worker, {telegram} from './index.mjs';

export class BotNotify extends WorkerEntrypoint {
  async socialConnected(tenantId, social) {
    const store = new D1Store(this.env.DB);
    const bot = createBot({store, tg: telegram(this.env), env: this.env, ...(this.env.KEITARO_BRIDGE ? {keitaro: containerKeitaro(this.env)} : {})});
    try { await bot.notifySocialConnected(String(tenantId), social || {}); } catch {}
  }
}

export default worker;
