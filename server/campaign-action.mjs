// Campaign write actions: pause/resume and daily budget. Scoped to the social's
// own token+session; every write reads before and after and verifies the result.
// status is ACTIVE|PAUSED; dailyBudget is minor currency units (e.g. cents).
export function validateAction(a) {
  const campaignId = String(a?.campaignId || '');
  if (!/^\d{5,20}$/.test(campaignId)) throw new Error('Unsupported action');
  const out = {campaignId};
  if (a.status !== undefined) {
    if (!['ACTIVE', 'PAUSED'].includes(a.status)) throw new Error('Unsupported action');
    out.status = a.status;
  }
  if (a.dailyBudget !== undefined && a.dailyBudget !== null) {
    const b = Number(a.dailyBudget);
    if (!Number.isInteger(b) || b < 100 || b > 100000000) throw new Error('Unsupported action');
    out.dailyBudget = b;
  }
  if (out.status === undefined && out.dailyBudget === undefined) throw new Error('Unsupported action');
  return out;
}

export async function applyCampaignAction(connection, action, {chromium} = {}) {
  const act = validateAction(action);
  if (!chromium) ({chromium} = await import('playwright'));
  const browser = await chromium.launch({headless: true, proxy: connection.proxy || undefined});
  const deadline = setTimeout(() => void browser.close().catch(() => {}), 180000);
  try {
    const context = await browser.newContext({userAgent: connection.userAgent, storageState: connection.storageState || {cookies: connection.cookies, origins: []}});
    const page = await context.newPage();
    await page.goto('https://adsmanager.facebook.com/adsmanager/', {waitUntil: 'domcontentloaded', timeout: 60000});
    await page.waitForFunction(id => { try { return String(globalThis.require('CurrentUserInitialData').USER_ID) === id; } catch { return false; } }, connection.userId, {timeout: 30000});
    const result = await page.evaluate(async ({userId, token, campaignId, status, dailyBudget}) => {
      if (String(globalThis.require('CurrentUserInitialData').USER_ID) !== userId) throw new Error('Identity mismatch');
      const call = (method, fields) => new Promise((resolve, reject) => { const x = new XMLHttpRequest(), url = new URL('https://graph.facebook.com/v25.0/' + campaignId); const body = new URLSearchParams({access_token: token, ...fields}); if (method === 'GET') url.search = body.toString(); x.open(method, url.href, true); x.withCredentials = true; x.responseType = 'json'; x.timeout = 20000; if (method === 'POST') x.setRequestHeader('Content-Type', 'application/x-www-form-urlencoded'); x.onload = () => resolve({httpStatus: x.status, body: x.response}); x.onerror = () => reject(new Error('network')); x.ontimeout = () => reject(new Error('timeout')); x.send(method === 'POST' ? body.toString() : null); });
      const clean = r => ({httpStatus: r.httpStatus, code: r.body?.error?.code, subcode: r.body?.error?.error_subcode, message: r.body?.error?.error_user_msg || r.body?.error?.message});
      const F = 'id,name,account_id,status,effective_status,daily_budget';
      const before = await call('GET', {fields: F});
      if (before.body?.id !== campaignId || before.body?.error) return {state: 'failed', stage: 'read_before', error: clean(before)};
      if (!['PAUSED', 'ACTIVE'].includes(before.body.status)) return {state: 'failed', stage: 'unsupported_status', before: before.body};
      const patch = {};
      if (status && before.body.status !== status) patch.status = status;
      if (dailyBudget && String(before.body.daily_budget || '') !== String(dailyBudget)) patch.daily_budget = String(dailyBudget);
      let write = null;
      if (Object.keys(patch).length) { write = await call('POST', patch); if (write.body?.success !== true) return {state: 'failed', stage: 'write', before: before.body, error: clean(write)}; }
      const after = await call('GET', {fields: F});
      const okStatus = !status || after.body?.status === status;
      const okBudget = !dailyBudget || String(after.body?.daily_budget || '') === String(dailyBudget);
      return {state: after.body?.id === campaignId && okStatus && okBudget ? 'done' : 'unverified', before: before.body, after: after.body?.error ? undefined : after.body, error: after.body?.error ? clean(after) : undefined, changed: !!write};
    }, {userId: connection.userId, token: connection.token, campaignId: act.campaignId, status: act.status || null, dailyBudget: act.dailyBudget || null});
    return {actionResult: {...result, campaignId: act.campaignId, requestedStatus: act.status || null, requestedBudget: act.dailyBudget || null, observedAt: new Date().toISOString()}, storageState: await context.storageState()};
  } finally { clearTimeout(deadline); await browser.close(); }
}
