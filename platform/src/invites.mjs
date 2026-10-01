// Invite codes: JS-XXXX-XXXX-XXXX, no look-alike characters (0/O, 1/I/L).
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const GROUP = '[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}';
// Word boundaries keep random runs inside jsi_ tokens from looking like a code.
const FIND = new RegExp('(?<![A-Za-z0-9_-])JS-?(' + GROUP + ')-?(' + GROUP + ')-?(' + GROUP + ')(?![A-Za-z0-9_-])', 'i');

export function newInviteCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  const chars = [...bytes].map(b => ALPHABET[b % ALPHABET.length]).join(''); // 248 = 8*31, bias is negligible for 12 chars
  return 'JS-' + chars.slice(0, 4) + '-' + chars.slice(4, 8) + '-' + chars.slice(8, 12);
}

// Finds a code in a message, tolerating lower case and missing dashes.
export function findInviteCode(text) {
  const m = String(text || '').toUpperCase().match(FIND);
  return m ? 'JS-' + m[1] + '-' + m[2] + '-' + m[3] : null;
}
