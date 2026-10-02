// Cheap API collection, Node side (runs in the container when a proxy is set).
// Mirrors cloud-collector/src/api-collector.mjs but imports from extension/,
// which is what the container image ships.
import {discoverSocial, graph, syncMeta} from '../extension/meta.mjs';
import {syncStructure} from '../extension/structure.mjs';
import {nodeGraphFetcher} from './api-fetch.mjs';

const STRUCTURE_MAX_AGE_MS = 60 * 60 * 1000;

// Verifies the token/proxy by reading /me through the proxy. Throws {code:'proxy'}
// with a readable detail when the proxy fails, {code:190/102} on a dead token.
export async function apiValidate(connection) {
  const fetcher = nodeGraphFetcher(connection);
  const me = await graph('me', {fields: 'id'}, connection.token, fetcher);
  if (String(me.id) !== String(connection.userId)) throw Object.assign(new Error('identity'), {code: 'identity'});
  return true;
}

export async function collectViaApi(connection, range, {previous, now = Date.now} = {}) {
  const fetcher = nodeGraphFetcher(connection);
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
