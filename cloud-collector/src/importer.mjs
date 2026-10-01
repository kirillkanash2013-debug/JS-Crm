// Import of socials from an antidetect account: every profile logged into
// Facebook becomes a social named after the profile, with the profile's proxy,
// User-Agent and cookies. The token is taken from the Ads Manager page through
// that proxy (no browser); when the page gives none, the first collection runs
// in the browser fallback and takes the token there.
import {graph} from '../../extension/meta.mjs';
import {cleanCookies} from './connection.mjs';
import {graphFetcher} from './proxy-fetch.mjs';
import {tokenFromSession} from './session-token.mjs';

export const REIMPORT_MS = 24 * 60 * 60 * 1000;
const FALLBACK_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const MAX_PROFILES = 200;

export async function importProfiles(client, {connect, browserAvailable = false}) {
  const profiles = (await client.profiles()).slice(0, MAX_PROFILES);
  const items = [], skipped = [];
  for (const p of profiles) {
    const skip = reason => skipped.push({name: p.name, reason});
    if (!p.proxy) { skip('no_proxy'); continue; }
    let raw;
    try { raw = client.cookies ? await client.cookies(p.id) : null; } catch { skip('cookies_error'); continue; }
    if (!raw) { skip('no_cookies'); continue; }
    const userId = raw.find(c => c?.name === 'c_user' && /facebook\.com$/.test(String(c.domain || '')))?.value;
    if (!/^\d{3,30}$/.test(String(userId || ''))) { skip('no_facebook'); continue; }
    const conn = {userId, userAgent: p.userAgent || FALLBACK_UA, proxy: p.proxy, cookies: cleanCookies(raw, userId), label: p.name, profileId: p.id};
    try {
      const found = await tokenFromSession(conn, {connect});
      if (found.userId && found.userId !== userId) { skip('other_user'); continue; }
      let token = null;
      for (const t of found.tokens) {
        try {
          const me = await graph('me', {fields: 'id'}, t, graphFetcher({connect, connection: {...conn, token: t}}));
          if (String(me.id) === userId) { token = t; break; }
        } catch (e) { if (e.code === 'proxy') throw e; }
      }
      if (token) items.push({...conn, token});
      else if (browserAvailable) items.push({...conn, token: null});
      else skip('no_token');
    } catch (e) {
      if (e.code === 'needs_auth') skip('logged_out');
      else if (e.code === 'proxy') skip('proxy');
      else if (browserAvailable) items.push({...conn, token: null}); // page form changed: let the browser take the token
      else skip('no_token');
    }
  }
  return {at: new Date().toISOString(), found: profiles.length, items, skipped};
}
