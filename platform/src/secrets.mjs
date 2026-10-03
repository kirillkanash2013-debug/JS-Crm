// AES-256-GCM for client API keys. Each tenant gets its own key derived
// from MASTER_KEY with HKDF, so one leaked row never opens another tenant.
async function tenantKey(masterKey, tenantId) {
  const raw = Uint8Array.from(atob(masterKey), c => c.charCodeAt(0));
  if (raw.length !== 32) throw new Error('MASTER_KEY must be 32 bytes in base64');
  const base = await crypto.subtle.importKey('raw', raw, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    {name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: new TextEncoder().encode('tenant:' + tenantId)},
    base, {name: 'AES-GCM', length: 256}, false, ['encrypt', 'decrypt']);
}

export async function sealSecret(masterKey, tenantId, plain) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({name: 'AES-GCM', iv}, await tenantKey(masterKey, tenantId), new TextEncoder().encode(plain));
  const out = new Uint8Array(12 + data.byteLength);
  out.set(iv); out.set(new Uint8Array(data), 12);
  let binary = '';
  for (let offset = 0; offset < out.length; offset += 8192) binary += String.fromCharCode(...out.subarray(offset,offset+8192));
  return btoa(binary);
}

export async function openSecret(masterKey, tenantId, sealed) {
  const bytes = Uint8Array.from(atob(sealed), c => c.charCodeAt(0));
  const plain = await crypto.subtle.decrypt({name: 'AES-GCM', iv: bytes.slice(0, 12)}, await tenantKey(masterKey, tenantId), bytes.slice(12));
  return new TextDecoder().decode(plain);
}
