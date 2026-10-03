import {resumeCollection} from './refresh.mjs';
import {operationsRoute,operationsTick} from './operations.mjs';
// JS Control platform Worker: payments → integration token → bot onboarding
// → plugin login → dashboard. One deployment serves every client (tenant).
import {PLANS, applyPayment, authenticate} from './accounts.mjs';
import {createBot} from './bot.mjs';
import {containerKeitaro} from './keitaro.mjs';
import {dashboardPage, dashboardSummary} from './dashboard.mjs';
import {openSecret} from './secrets.mjs';
import {D1Store} from './store.mjs';

const json = (status, body) => Response.json(body, {status, headers: {'cache-control': 'no-store'}});

async function sameSecret(a, b) {
  if (!a || !b) return false;
  const enc = s => crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  const [x, y] = await Promise.all([enc(a), enc(b)]);
  return crypto.subtle.timingSafeEqual ? crypto.subtle.timingSafeEqual(x, y) : new Uint8Array(x).every((v, i) => v === new Uint8Array(y)[i]);
}

async function hmacHex(secret, body) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), {name: 'HMAC', hash: 'SHA-256'}, false, ['sign']);
  return [...new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)))].map(b => b.toString(16).padStart(2, '0')).join('');
}

function telegram(env) {
  return async (method, payload) => {
    const r = await fetch('https://api.telegram.org/bot' + env.TELEGRAM_BOT_TOKEN + '/' + method, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(payload)});
    const body = await r.json().catch(() => ({}));
    if (!body.ok) {const e=new Error('Telegram request failed');e.code=/message is not modified/i.test(body.description||'')?'message_unchanged':/message to edit not found|message can.t be edited/i.test(body.description||'')?'message_missing':'telegram_failed';throw e;}
    return body.result;
  };
}

export async function route(request, env, {store, tg, collectorStatus = async () => null} = {}) {
  const url = new URL(request.url);
  const path = url.pathname;

  if(path.startsWith('/internal/admin/'))return operationsRoute(request,env,{store,tg});

  if (request.method === 'GET' && path === '/health') return json(200, {ok: true, service: 'js-control-platform', keitaroTransport: env.KEITARO_BRIDGE?'container':'worker'});

  // Telegram webhook. Secret header is set by setWebhook(secret_token=...).
  if (request.method === 'POST' && path === '/telegram') {
    if (!await sameSecret(request.headers.get('x-telegram-bot-api-secret-token'), env.TELEGRAM_WEBHOOK_SECRET)) return json(401, {error: 'unauthorized'});
    const update = await request.json();
    const msg=update.message||update.callback_query?.message;
    if(msg?.chat?.type&&msg.chat.type!=='private')return json(200,{ok:true});
    if(msg?.chat?.id&& (update.callback_query?.from?.id||update.message?.from?.id) && String(msg.chat.id)!==String(update.callback_query?.from?.id||update.message?.from?.id))return json(200,{ok:true});
    if(update.update_id!==undefined&&!await store.claimUpdate(update.update_id))return json(200,{ok:true,duplicate:true});
    try{await createBot({store, tg, env, ...(env.KEITARO_BRIDGE?{keitaro:containerKeitaro(env)}:{})})(update);if(update.update_id!==undefined)await store.finishUpdate(update.update_id,true);}
    catch(e){if(update.update_id!==undefined)await store.finishUpdate(update.update_id,false);throw e;}
    return json(200, {ok: true});
  }

  // Website / payment provider: HMAC-signed confirmation of a paid order.
  // The response carries the new integration token for the success page.
  if (request.method === 'POST' && path === '/billing/webhook') {
    const raw = await request.text();
    if (!env.BILLING_WEBHOOK_SECRET || raw.length > 16000 || !await sameSecret(request.headers.get('x-signature'), await hmacHex(env.BILLING_WEBHOOK_SECRET, raw))) return json(401, {error: 'unauthorized'});
    let b;try{b=JSON.parse(raw);}catch{return json(400,{error:'invalid_json'});}
    if(typeof b.paymentId!=='string'||!b.paymentId.trim()||b.paymentId.length>200)return json(400,{error:'payment_id_required'});
    const price=Number(env['WEB_PRICE_'+String(b.plan).toUpperCase()]);
    if(!(price>0))return json(503,{error:'billing_not_configured'});
    if(Number(b.amount)!==price||b.currency!==(env.WEB_CURRENCY||'USD'))return json(400,{error:'invalid_payment_amount'});
    if (!PLANS[b.plan]) return json(400, {error: 'unknown_plan'});
    const result = await applyPayment(store, {paymentId: 'web:' + b.paymentId, provider: String(b.provider || 'web'), plan: b.plan, name: b.name, tenantId: b.tenantId, amount: b.amount, currency: b.currency, masterKey: env.MASTER_KEY});
    if(b.tenantId)await resumeCollection(store,env,result.tenant.id);
    return json(200,{tenantId:result.tenant.id,paidUntil:result.tenant.paidUntil,duplicate:result.duplicate});
  }

  // Plugin login with the integration token.
  if (request.method === 'POST' && path === '/v1/extension/login') {
    const b = await request.json().catch(() => ({}));
    const {tenant, error} = await authenticate(store, b.token, 'integration');
    if (error === 'invalid') return json(401, {error: 'invalid_token'});
    if (error === 'expired') return json(402, {error: 'subscription_expired', paidUntil: tenant.paidUntil});
    const settings = await store.settings(tenant.id);
    return json(200, {tenant: {name: tenant.name, plan: tenant.plan, socialLimit: tenant.socialLimit, paidUntil: tenant.paidUntil}, onboarded: !!settings.onboardedAt, collector: {origin: env.COLLECTOR_URL || null}});
  }

  // Dashboard by secret link /d/<jsd_token> and its JSON for auto-refresh.
  const dash = path.match(/^\/(d|api\/d)\/([A-Za-z0-9_-]+)$/);
  if (request.method === 'GET' && dash) {
    const {tenant, error} = await authenticate(store, dash[2], 'dashboard');
    if (error === 'invalid') return new Response('Ссылка недействительна. Получите новую в боте: 📊 Дашборд.', {status: 404, headers: {'content-type': 'text/plain; charset=utf-8'}});
    if (error === 'expired') return new Response('Подписка истекла. Продлите её в боте: 💳 Подписка.', {status: 402, headers: {'content-type': 'text/plain; charset=utf-8'}});
    const summary = dashboardSummary(tenant, await store.settings(tenant.id), await collectorStatus(tenant.id));
    if (dash[1] === 'api/d') return json(200, summary);
    return new Response(dashboardPage(summary), {headers: {'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY'}});
  }

  return json(404, {error: 'not_found'});
}

// Reads a tenant's live data from the collector for the dashboard. The tenant's
// integration token is stored sealed (per-tenant AES-GCM), so the platform can
// call the collector as that tenant without any shared cross-worker secret.
export async function collectorStatus(env, store, tenantId) {
  if ((!env.COLLECTOR && !env.COLLECTOR_URL) || !env.MASTER_KEY) return null;
  const tenant = await store.tenant(tenantId);
  if (!tenant?.integrationTokenEnc) return null;
  let token;
  try { token = await openSecret(env.MASTER_KEY, tenantId, tenant.integrationTokenEnc); } catch { return null; }
  const base = String(env.COLLECTOR_URL || '').replace(/\/+$/, '');
  // Prefer the service binding (reliable worker-to-worker) over the public URL.
  const get = async path => {
    try { const r = await (env.COLLECTOR ? env.COLLECTOR.fetch(base + path, {headers: {Authorization: 'Bearer ' + token}}) : fetch(base + path, {headers: {Authorization: 'Bearer ' + token}})); return r.ok ? await r.json() : null; }
    catch { return null; }
  };
  const status = await get('/v1/status');
  const connections = status && Array.isArray(status.connections) ? status.connections : [];
  if (!connections.length) return null;
  const observedAt = Object.values(status.results || {}).map(r => r && r.observedAt).filter(Boolean).sort().at(-1) || null;
  const settings=await store.settings(tenantId);
  const today = new Date().toLocaleDateString('en-CA',{timeZone:settings.timezone||'UTC'});
  const report = await get('/v1/report?since=' + today + '&until=' + today);
  return {
    socials: connections.length,
    observedAt,
    connections: connections.map(c => ({label: c.label || c.userId, mode: c.collectMode || 'api'})),
    totals: (report && report.totals) || {},
    rows: report && Array.isArray(report.rows) ? report.rows.length : 0
  };
}

// telegram() and containerKeitaro() are reused by the BotNotify entrypoint in
// entry.mjs (the wrangler main); exported here so that module can build a bot.
export {telegram};

export default {
  scheduled(_event,env,ctx){ctx.waitUntil(operationsTick(env,telegram(env)));},
  fetch(request, env) {
    const store = new D1Store(env.DB);
    return route(request, env, {store, tg: telegram(env), collectorStatus: id => collectorStatus(env, store, id)}).catch(() => json(500, {error: 'internal'}));
  }
};
