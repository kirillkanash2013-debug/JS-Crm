// Keitaro checks for the onboarding wizard.
export function keitaroOrigin(text) {
  let u;
  try { u = new URL(String(text || '').trim()); } catch { return null; }
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) return null;
  return u.origin;
}

// Returns 'ok' | 'bad_key' | 'forbidden' | 'unreachable'. Uses the same Api-Key
// header as the CRM. 403 (even without a valid key) means Keitaro blocks the API
// itself — an IP allowlist or WAF — not a wrong key.
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
