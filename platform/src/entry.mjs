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
  #bot() {
    const store = new D1Store(this.env.DB);
    return createBot({store, tg: telegram(this.env), env: this.env, ...(this.env.KEITARO_BRIDGE ? {keitaro: containerKeitaro(this.env)} : {})});
  }
  async socialConnected(tenantId, social) { await this.#bot().notifySocialConnected(String(tenantId), social || {}); }
  async socialCollected(tenantId, social) { await this.#bot().notifySocialCollected(String(tenantId), social || {}); }
  async statsStateChanged(tenantId,phase) { if(['facebook','failed'].includes(phase)) await this.#bot().notifyStatsPhase(String(tenantId),phase); }
  async statsRefreshed(tenantId) { await this.#bot().notifyStatsRefresh(String(tenantId)); }
}

export default worker;
