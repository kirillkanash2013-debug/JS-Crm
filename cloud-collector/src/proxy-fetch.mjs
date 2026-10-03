// Graph API requests through the social's own proxy, without a browser.
// Workers' fetch() cannot use a proxy, so we open a TCP socket
// (cloudflare:sockets connect, injected for tests), tunnel through
// HTTP CONNECT or SOCKS5, upgrade to TLS and speak HTTP/1.1 ourselves.
// Requests look like Ads Manager's own: access_token in the query, the
// profile's cookies and User-Agent — the same inputs Dolphin keeps per account.
const enc = new TextEncoder(), dec = new TextDecoder();
const GRAPH_HOST = 'graph.facebook.com';
const MAX_HEAD = 64 * 1024, MAX_BODY = 16 * 1024 * 1024;

export class ProxyError extends Error {
  constructor(message) { super(message); this.code = 'proxy'; }
}

function concat(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a); out.set(b, a.length);
  return out;
}

function indexOf(buf, seq) {
  outer: for (let i = 0; i + seq.length <= buf.length; i++) {
    for (let j = 0; j < seq.length; j++) if (buf[i + j] !== seq[j]) continue outer;
    return i;
  }
  return -1;
}

class Reader {
  constructor(readable) { this.reader = readable.getReader(); this.buf = new Uint8Array(0); }
  async fill() {
    const {value, done} = await this.reader.read();
    if (done) return false;
    this.buf = concat(this.buf, value);
    return true;
  }
  take(n) { const out = this.buf.slice(0, n); this.buf = this.buf.slice(n); return out; }
  async exact(n) {
    while (this.buf.length < n) if (!await this.fill()) throw new ProxyError('Connection closed early');
    return this.take(n);
  }
  async until(seq, max) {
    for (;;) {
      const i = indexOf(this.buf, seq);
      if (i >= 0) return this.take(i + seq.length);
      if (this.buf.length > max) throw new ProxyError('Response header too large');
      if (!await this.fill()) throw new ProxyError('Connection closed early');
    }
  }
  async rest(max) {
    while (await this.fill()) if (this.buf.length > max) throw new ProxyError('Response too large');
    return this.take(this.buf.length);
  }
  release() { this.reader.releaseLock(); }
}

async function write(socket, bytes) {
  const writer = socket.writable.getWriter();
  try { await writer.write(bytes); } finally { writer.releaseLock(); }
}

export function parseProxy(proxy) {
  if (!proxy?.server) return null;
  let u;
  try { u = new URL(proxy.server); } catch { throw new ProxyError('Invalid proxy address'); }
  if (!['http:', 'socks5:'].includes(u.protocol) || !u.port) throw new ProxyError('Proxy must be http:// or socks5:// with a port');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  // Workers cannot reach private networks anyway; refuse obvious local targets early.
  if (/^(localhost|127\.|10\.|192\.168\.|169\.254\.|0\.)/i.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host) || host === '::1') throw new ProxyError('Локальный адрес прокси недоступен с сервера');
  return {type: u.protocol === 'http:' ? 'http' : 'socks5', host, port: Number(u.port), username: proxy.username || '', password: proxy.password || ''};
}

async function httpTunnel(socket, p, host) {
  const auth = p.username ? 'Proxy-Authorization: Basic ' + btoa(p.username + ':' + p.password) + '\r\n' : '';
  await write(socket, enc.encode('CONNECT ' + host + ':443 HTTP/1.1\r\nHost: ' + host + ':443\r\n' + auth + '\r\n'));
  const reader = new Reader(socket.readable);
  try {
    const head = dec.decode(await reader.until(enc.encode('\r\n\r\n'), MAX_HEAD));
    const status = Number(head.split(' ')[1]);
    if (status === 407) throw new ProxyError('Прокси отклонил логин или пароль');
    if (status !== 200) throw new ProxyError('Прокси отклонил туннель (HTTP ' + status + ')');
    if (reader.buf.length) throw new ProxyError('Unexpected data from proxy');
  } finally { reader.release(); }
}

async function socksTunnel(socket, p, hostName) {
  const reader = new Reader(socket.readable);
  try {
    await write(socket, new Uint8Array(p.username ? [5, 2, 0, 2] : [5, 1, 0]));
    const [ver, method] = await reader.exact(2);
    if (ver !== 5 || method === 0xff) throw new ProxyError('SOCKS5-прокси отклонил способ авторизации');
    if (method === 2) {
      const u = enc.encode(p.username), w = enc.encode(p.password);
      if (u.length > 255 || w.length > 255) throw new ProxyError('Proxy credentials too long');
      await write(socket, new Uint8Array([1, u.length, ...u, w.length, ...w]));
      const [, ok] = await reader.exact(2);
      if (ok !== 0) throw new ProxyError('Прокси отклонил логин или пароль');
    }
    const host = enc.encode(hostName);
    await write(socket, new Uint8Array([5, 1, 0, 3, host.length, ...host, 443 >> 8, 443 & 255]));
    const [, rep, , atyp] = await reader.exact(4);
    if (rep !== 0) throw new ProxyError('SOCKS5-прокси не смог подключиться (код ' + rep + ')');
    const skip = atyp === 1 ? 4 : atyp === 4 ? 16 : (await reader.exact(1))[0];
    await reader.exact(skip + 2);
    if (reader.buf.length) throw new ProxyError('Unexpected data from proxy');
  } finally { reader.release(); }
}

function decodeChunked(body) {
  let out = new Uint8Array(0), at = 0;
  for (;;) {
    const lineEnd = indexOf(body.subarray(at), enc.encode('\r\n'));
    if (lineEnd < 0) throw new ProxyError('Broken chunked response');
    const size = parseInt(dec.decode(body.subarray(at, at + lineEnd)).split(';')[0], 16);
    if (!Number.isFinite(size)) throw new ProxyError('Broken chunked response');
    at += lineEnd + 2;
    if (size === 0) return out;
    out = concat(out, body.subarray(at, at + size));
    at += size + 2;
  }
}

export async function readResponse(socket) {
  const reader = new Reader(socket.readable);
  try {
    const head = dec.decode(await reader.until(enc.encode('\r\n\r\n'), MAX_HEAD)).split('\r\n');
    const status = Number(head[0].split(' ')[1]);
    const headers = new Map();
    for (const line of head.slice(1)) {
      const i = line.indexOf(':');
      if (i > 0) headers.set(line.slice(0, i).trim().toLowerCase(), line.slice(i + 1).trim());
    }
    if (headers.has('content-encoding') && headers.get('content-encoding') !== 'identity') throw new ProxyError('Compressed response not supported');
    let body;
    if (headers.has('content-length')) {
      const n = Number(headers.get('content-length'));
      if (!(n >= 0 && n <= MAX_BODY)) throw new ProxyError('Response too large');
      body = await reader.exact(n);
    } else {
      body = await reader.rest(MAX_BODY);
      if (/chunked/i.test(headers.get('transfer-encoding') || '')) body = decodeChunked(body);
    }
    return {status, headers, body};
  } finally { reader.release(); }
}

// Hosts the collector may reach through a client's proxy.
const ALLOWED_HOSTS = new Set([GRAPH_HOST, 'adsmanager.facebook.com', 'business.facebook.com', 'www.facebook.com']);

// One HTTPS GET through the proxy (or directly).
export async function httpsGet(host, pathAndQuery, {connect, proxy, headers, signal}) {
  if (!ALLOWED_HOSTS.has(host)) throw new ProxyError('Host not allowed');
  const p = parseProxy(proxy);
  const socket = p
    ? connect({hostname: p.host, port: p.port}, {secureTransport: 'starttls'})
    : connect({hostname: host, port: 443}, {secureTransport: 'on'});
  let tls = p ? null : socket;
  const abort = () => { try { (tls || socket).close(); } catch {} };
  signal?.addEventListener('abort', abort, {once: true});
  try {
    if (p) {
      try { await socket.opened; } catch { throw new ProxyError('Прокси недоступен — не принимает подключение с сервера (возможно, привязан к вашему IP)'); }
      await (p.type === 'http' ? httpTunnel(socket, p, host) : socksTunnel(socket, p, host));
      tls = socket.startTls({expectedServerHostname: host});
      // Wait for the TLS handshake to finish before sending the request;
      // writing too early is reported by the runtime as "TLS Handshake Failed".
      try { await tls.opened; } catch (e) { throw new ProxyError('TLS через прокси не установился: ' + (e && e.message ? e.message : e)); }
    }
    const lines = ['GET ' + pathAndQuery + ' HTTP/1.1', 'Host: ' + host, 'Connection: close', 'Accept-Encoding: identity'];
    for (const [k, v] of Object.entries(headers || {})) if (v) lines.push(k + ': ' + String(v).replace(/[\r\n]/g, ''));
    await write(tls, enc.encode(lines.join('\r\n') + '\r\n\r\n'));
    return await readResponse(tls);
  } catch (e) {
    if (signal?.aborted) throw new ProxyError('Истекло время ожидания прокси');
    throw e instanceof ProxyError || e.code ? e : new ProxyError('Не удалось подключиться через прокси: ' + (e && e.message ? e.message : e));
  } finally {
    signal?.removeEventListener('abort', abort);
    abort();
  }
}

export const graphGet = (pathAndQuery, options) => httpsGet(GRAPH_HOST, pathAndQuery, options);

const COOKIE_DOMAINS = new Set(['facebook.com', '.facebook.com', 'graph.facebook.com', '.graph.facebook.com']);

export function cookieHeader(cookies) {
  return (cookies || []).filter(c => COOKIE_DOMAINS.has(c.domain) && /^[^\s;=]+$/.test(c.name) && !/[\r\n;]/.test(c.value))
    .map(c => c.name + '=' + c.value).join('; ');
}

// fetch-compatible adapter for extension/meta.mjs and structure.mjs.
export function graphFetcher({connect, connection}) {
  const deadline=Date.now()+4*60000;
  const cookies = cookieHeader(connection.storageState?.cookies || connection.cookies);
  const fetcher = async (url, options = {}) => {
    if(Date.now()>=deadline)throw new ProxyError('Collection deadline exceeded');
    const signals=[AbortSignal.timeout(Math.max(1,deadline-Date.now()))];
    if(options.signal)signals.push(options.signal);
    const u = new URL(url);
    if (u.origin !== 'https://' + GRAPH_HOST || (options.method || 'GET') !== 'GET') throw new ProxyError('Only Graph API reads are allowed');
    const auth = options.headers?.Authorization || '';
    if (auth.startsWith('Bearer ')) u.searchParams.set('access_token', auth.slice(7));
    const r = await graphGet(u.pathname + u.search, {connect, proxy: connection.proxy, signal: AbortSignal.any(signals), headers: {
      'User-Agent': connection.userAgent, Accept: '*/*', Cookie: cookies,
      Origin: 'https://adsmanager.facebook.com', Referer: 'https://adsmanager.facebook.com/'
    }});
    const text = dec.decode(r.body);
    return {ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => JSON.parse(text)};
  };
  // Like the page transport: no batch fallback, requests carry the session.
  fetcher.pageContext = true;
  return fetcher;
}
