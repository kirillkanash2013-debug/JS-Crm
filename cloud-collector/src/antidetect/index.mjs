// Antidetect browser integrations. Each adapter turns the client's antidetect
// account into a list of profiles: {id, name, userAgent, proxy, cookies?}.
// Cloud APIs only — a local API (AdsPower) is unreachable from the server;
// for those the bookmark flow with a pasted proxy stays available.
import {dolphinAnty} from './dolphin.mjs';

export const ANTIDETECTS = {
  'dolphin-anty': {name: 'Dolphin Anty', create: dolphinAnty, cookies: true}
};

export function antidetectClient(config, fetcher = fetch) {
  const a = ANTIDETECTS[config?.type];
  if (!a) throw Object.assign(new Error('Unsupported antidetect'), {code: 'antidetect_type'});
  return a.create(config.token, fetcher);
}

// Same browser = same profile: the bookmark sends navigator.userAgent, which
// antidetects set per profile. Returns the profile only when the match is unique.
export function matchProfile(profiles, userAgent) {
  const found = profiles.filter(p => p.userAgent && p.userAgent === userAgent);
  return found.length === 1 ? found[0] : null;
}
