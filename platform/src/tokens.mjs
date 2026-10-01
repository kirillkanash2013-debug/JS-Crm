// Access tokens: random, prefixed by kind, stored only as SHA-256 hashes.
const PREFIX = {integration: 'jsi_', dashboard: 'jsd_'};
const PATTERN = /^(jsi|jsd)_[A-Za-z0-9_-]{43}$/;

function base64url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function newToken(kind) {
  if (!PREFIX[kind]) throw new Error('Unknown token kind');
  return PREFIX[kind] + base64url(crypto.getRandomValues(new Uint8Array(32)));
}

export function tokenKind(token) {
  const value = String(token || '').trim();
  if (!PATTERN.test(value)) return null;
  return value.startsWith('jsi_') ? 'integration' : 'dashboard';
}

export async function hashToken(token) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(token).trim()));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// Finds a token anywhere in a message, e.g. "/start jsi_..." or a pasted line.
export function findToken(text, kind) {
  const match = String(text || '').match(/(jsi|jsd)_[A-Za-z0-9_-]{43}/);
  return match && tokenKind(match[0]) === kind ? match[0] : null;
}
