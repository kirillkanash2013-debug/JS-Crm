// Cheap collection mode (Dolphin-style): plain Graph API reads with the
// saved token, cookies and proxy. No browser, runs inside the Durable Object.
import {discoverSocial, syncMeta} from '../../extension/meta.mjs';
import {syncStructure} from '../../extension/structure.mjs';

export const STRUCTURE_MAX_AGE_MS = 60 * 60 * 1000;

// Spend is read every run; campaign/adset/ad structure changes rarely, so it
// is re-read at most once an hour per account to save requests and rate limit.
export async function collectViaApi(connection, range, {fetcher, previous, now = Date.now}) {
  const quiet = () => {};
  const social = await discoverSocial(connection.token, connection.userId, quiet, fetcher);
  const reports = {}, structures = {};
  for (const a of social.accounts) {
    reports[a.id] = await syncMeta(a.id, range, connection.token, quiet, fetcher);
    const old = previous?.structures?.[a.id];
    structures[a.id] = old?.complete && now() - Date.parse(old.observedAt) < STRUCTURE_MAX_AGE_MS
      ? old
      : await syncStructure(a.id, connection.token, quiet, fetcher);
  }
  return {snapshot: {schemaVersion: 1, source: 'facebook-server', mode: 'api', complete: true, observedAt: new Date(now()).toISOString(), social, reports, structures}};
}
