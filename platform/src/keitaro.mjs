// Keitaro checks for the onboarding wizard.
export function keitaroOrigin(text) {
  let u;
  try { u = new URL(String(text || '').trim()); } catch { return null; }
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) return null;
  return u.origin;
}

// IP origins are checked through the private container service binding.
export async function checkKeitaro(origin, key, fetcher = fetch) {
  let r;
  try {
    r = await fetcher(origin + '/admin_api/v1/campaigns', {headers: {'Api-Key': key, Accept: 'application/json'}, redirect: 'manual', signal: AbortSignal.timeout(10000)});
  } catch { return 'unreachable'; }
  if (r.status === 401) return 'bad_key';
  if (r.status === 403) return 'forbidden';
  if (!r.ok) return 'unreachable';
  try { return Array.isArray(await r.json()) ? 'ok' : 'unreachable'; } catch { return 'unreachable'; }
}

export function containerKeitaro(env) {
 return async(origin,key)=>{
  try {
   const r=await env.KEITARO_BRIDGE.check(origin,key);
   console.log(JSON.stringify({event:'keitaro_check',transport:r.transport||'container',result:r.result,status:r.status||null,reason:r.reason||null}));
   return ['ok','bad_key','forbidden','unreachable'].includes(r.result)?r.result:'unreachable';
  }catch{return 'unreachable';}
 };
}

// Keitaro report rows (report/build + conversions/log) over the IP-bypass
// transport, via the collector service binding. Returns the raw bridge result
// {result, report, conversions} for the platform to aggregate and join.
export function keitaroReport(env) {
 return async(origin,key,opts)=>{
  try { return await env.KEITARO_BRIDGE.report(origin,key,opts); }
  catch { return {result:'unreachable'}; }
 };
}
