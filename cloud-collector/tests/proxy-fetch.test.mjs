import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import {cookieHeader, graphFetcher, graphGet, parseProxy} from '../src/proxy-fetch.mjs';
import {graph, pages} from '../../extension/meta.mjs';

// Self-signed certificate for the fake graph.facebook.com.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-'));
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=graph.facebook.com',
  '-addext', 'subjectAltName=DNS:graph.facebook.com', '-keyout', dir + '/k.pem', '-out', dir + '/c.pem'], {stdio: 'ignore'});
const cert = fs.readFileSync(dir + '/c.pem'), key = fs.readFileSync(dir + '/k.pem');

// Minimal cloudflare:sockets connect() over node:net/tls. Hostnames are mapped
// to local test servers; TLS is verified against the test certificate.
function socketApi(sock, opened) {
  let onData, onEnd;
  const readable = new ReadableStream({start(c) {
    onData = d => c.enqueue(new Uint8Array(d)); onEnd = () => { try { c.close(); } catch {} };
    sock.on('data', onData); sock.on('end', onEnd); sock.on('close', onEnd); sock.on('error', onEnd);
  }});
  const writable = new WritableStream({write: chunk => new Promise((res, rej) => sock.write(chunk, e => e ? rej(e) : res()))});
  return {readable, writable, opened, close() { sock.destroy(); },
    startTls({expectedServerHostname}) {
      sock.off('data', onData); sock.off('end', onEnd); sock.off('close', onEnd);
      const t = tls.connect({socket: sock, servername: expectedServerHostname, ca: cert});
      return socketApi(t, new Promise(r => t.once('secureConnect', r)));
    }};
}
function makeConnect(routes, log) {
  return ({hostname, port}, {secureTransport}) => {
    log.push(hostname + ':' + port + '/' + secureTransport);
    const target = routes[hostname];
    if (secureTransport === 'on') {
      const t = tls.connect({host: '127.0.0.1', port: target, servername: hostname, ca: cert});
      return socketApi(t, new Promise(r => t.once('secureConnect', r)));
    }
    const s = net.connect(target, '127.0.0.1');
    return socketApi(s, new Promise((r, j) => { s.once('connect', r); s.once('error', j); }));
  };
}

const seen = [];
const graphServer = https.createServer({cert, key}, (req, res) => {
  req.socket.on('error', () => {});
  seen.push({url: req.url, headers: req.headers});
  const u = new URL(req.url, 'https://graph.facebook.com');
  if (u.pathname === '/v25.0/me') return res.end(JSON.stringify({id: '100', name: 'Owner'}));
  if (u.pathname === '/v25.0/chunked') { res.write('{"data":[1,'); setTimeout(() => res.end('2]}'), 10); return; }
  if (u.pathname === '/v25.0/dead') { res.statusCode = 400; return res.end(JSON.stringify({error: {code: 190, message: 'Error validating access token'}})); }
  res.statusCode = 404; res.end('{}');
});

const proxyServer = http.createServer();
proxyServer.on('connect', (req, client) => {
  client.on('error', () => {});
  if (req.headers['proxy-authorization'] !== 'Basic ' + Buffer.from('user:pass').toString('base64')) { client.end('HTTP/1.1 407 Auth\r\n\r\n'); return; }
  const upstream = net.connect(graphServer.address().port, '127.0.0.1', () => { client.write('HTTP/1.1 200 Connection Established\r\n\r\n'); upstream.pipe(client); client.pipe(upstream); });
  upstream.on('error', () => {});
});

const socksServer = net.createServer(client => {
  client.on('error', () => {});
  client.once('data', greet => {
    assert.deepEqual([...greet], [5, 2, 0, 2]);
    client.write(Buffer.from([5, 2]));
    client.once('data', auth => {
      const u = auth.subarray(2, 2 + auth[1]).toString(), p = auth.subarray(3 + auth[1]).toString();
      client.write(Buffer.from([1, u === 'user' && p === 'pass' ? 0 : 1]));
      client.once('data', req => {
        assert.equal(req.subarray(5, 5 + req[4]).toString(), 'graph.facebook.com');
        const upstream = net.connect(graphServer.address().port, '127.0.0.1', () => {
          client.write(Buffer.from([5, 0, 0, 1, 1, 2, 3, 4, 1, 187])); upstream.pipe(client); client.pipe(upstream);
        });
        upstream.on('error', () => {});
      });
    });
  });
});

const listen = s => new Promise(r => s.listen(0, '127.0.0.1', r));
test.before(async () => { await listen(graphServer); await listen(proxyServer); await listen(socksServer); });
test.after(() => { graphServer.close(); proxyServer.close(); socksServer.close(); fs.rmSync(dir, {recursive: true, force: true}); });

const routes = () => ({'proxy.example': proxyServer.address().port, 'socks.example': socksServer.address().port, 'graph.facebook.com': graphServer.address().port});
const connection = proxy => ({userId: '100', token: 'EA' + 't'.repeat(30), userAgent: 'Mozilla/5.0 Test',
  cookies: [{name: 'c_user', value: '100', domain: '.facebook.com'}, {name: 'xs', value: 'abc', domain: '.facebook.com'}, {name: 'other', value: 'x', domain: '.instagram.com'}], proxy});

for (const [name, proxy] of [['HTTP CONNECT', {server: 'http://proxy.example:8080', username: 'user', password: 'pass'}],
  ['SOCKS5', {server: 'socks5://socks.example:1080', username: 'user', password: 'pass'}], ['direct', undefined]]) {
  test('Graph API through ' + name + ': token in query, cookies and UA sent, TLS to graph.facebook.com', async () => {
    const log = [];
    const fetcher = graphFetcher({connect: makeConnect(routes(), log), connection: connection(proxy)});
    seen.length = 0;
    assert.deepEqual(await graph('me', {fields: 'id,name'}, connection().token, fetcher), {id: '100', name: 'Owner'});
    const req = seen[0];
    assert.equal(new URL(req.url, 'https://x').searchParams.get('access_token'), connection().token);
    assert.equal(req.headers.cookie, 'c_user=100; xs=abc');
    assert.equal(req.headers['user-agent'], 'Mozilla/5.0 Test');
    assert.equal(req.headers.origin, 'https://adsmanager.facebook.com');
    assert.equal(req.headers.authorization, undefined);
    assert.equal(log[0], proxy ? (name === 'SOCKS5' ? 'socks.example:1080/starttls' : 'proxy.example:8080/starttls') : 'graph.facebook.com:443/on');
    const err = await graph('dead', {}, connection().token, fetcher).catch(e => e);
    assert.equal(err.code, 190);
  });
}

test('chunked responses, wrong proxy password, private proxy, non-graph URLs', async () => {
  const log = [], connect = makeConnect(routes(), log);
  const r = await graphGet('/v25.0/chunked', {connect, proxy: {server: 'http://proxy.example:8080', username: 'user', password: 'pass'}, headers: {}});
  assert.deepEqual(JSON.parse(new TextDecoder().decode(r.body)), {data: [1, 2]});
  await assert.rejects(graphGet('/v25.0/me', {connect, proxy: {server: 'http://proxy.example:8080', username: 'user', password: 'bad'}, headers: {}}), /логин или пароль/);
  await assert.rejects(graphGet('/v25.0/me', {connect, proxy: {server: 'socks5://socks.example:1080', username: 'user', password: 'bad'}, headers: {}}), /логин или пароль/);
  assert.throws(() => parseProxy({server: 'http://192.168.1.5:3128'}), /Локальный адрес/);
  assert.throws(() => parseProxy({server: 'ftp://x.example:21'}), /http:\/\/ or socks5/);
  const fetcher = graphFetcher({connect, connection: connection()});
  await assert.rejects(fetcher('https://evil.example/x', {method: 'GET', headers: {}}), /Only Graph API/);
  await assert.rejects(fetcher('https://graph.facebook.com/v25.0/me', {method: 'POST', headers: {}}), /Only Graph API/);
  assert.equal(cookieHeader([{name: 'a', value: 'b\r\nX: y', domain: '.facebook.com'}]), '');
});

test('pagination works through the proxy fetcher', async () => {
  const fetcher = graphFetcher({connect: makeConnect(routes(), []), connection: connection({server: 'http://proxy.example:8080', username: 'user', password: 'pass'})});
  assert.deepEqual(await pages('chunked', {}, connection().token, fetcher), [1, 2]);
});
