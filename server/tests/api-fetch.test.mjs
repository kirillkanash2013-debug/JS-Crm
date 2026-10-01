process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; // self-signed test cert below
import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import net from 'node:net';
import {nodeGraphFetcher, cookieHeader} from '../api-fetch.mjs';
import {graph} from '../../extension/meta.mjs';

// The whole point: SOCKS5 WITH login + TLS to graph.facebook.com, which
// Cloudflare Workers / Chromium cannot do but Node handles natively.
test('Graph API through a SOCKS5 proxy with auth, over TLS', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'np-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=graph.facebook.com',
    '-addext', 'subjectAltName=DNS:graph.facebook.com', '-keyout', dir + '/k.pem', '-out', dir + '/c.pem'], {stdio: 'ignore'});
  const cert = fs.readFileSync(dir + '/c.pem'), key = fs.readFileSync(dir + '/k.pem');

  const seen = [];
  const gs = https.createServer({cert, key}, (req, res) => { seen.push({url: req.url, cookie: req.headers.cookie, ua: req.headers['user-agent']}); res.end(JSON.stringify({id: '100200300', name: 'A'})); });
  gs.on('tlsClientError', () => {});
  await new Promise(r => gs.listen(0, '127.0.0.1', r));
  const gport = gs.address().port;

  let authSeen = null;
  const socks = net.createServer(c => {
    c.on('error', () => {});
    c.once('data', () => { c.write(Buffer.from([5, 2])); // require user/pass
      c.once('data', a => { const ul = a[1], u = a.subarray(2, 2 + ul).toString(), pl = a[2 + ul], p = a.subarray(3 + ul, 3 + ul + pl).toString(); authSeen = u + ':' + p;
        c.write(Buffer.from([1, u === 'user' && p === 'pass' ? 0 : 1]));
        c.once('data', () => { const up = net.connect(gport, '127.0.0.1', () => { c.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, (gport >> 8) & 255, gport & 255])); up.pipe(c); c.pipe(up); }); up.on('error', () => {}); });
      });
    });
  });
  await new Promise(r => socks.listen(0, '127.0.0.1', r));

  const connection = {userId: '100200300', token: 'EA' + 't'.repeat(30), userAgent: 'Mozilla/5.0 Test',
    cookies: [{name: 'c_user', value: '100200300', domain: '.facebook.com'}, {name: 'xs', value: 'abc', domain: '.facebook.com'}, {name: 'x', value: 'y', domain: '.google.com'}],
    proxy: {server: 'socks5://127.0.0.1:' + socks.address().port, username: 'user', password: 'pass'}};

  try {
    const me = await graph('me', {fields: 'id,name'}, connection.token, nodeGraphFetcher(connection));
    assert.deepEqual(me, {id: '100200300', name: 'A'});
    assert.equal(authSeen, 'user:pass', 'proxy auth was sent');
    assert.equal(new URL(seen[0].url, 'https://x').searchParams.get('access_token'), connection.token);
    assert.equal(seen[0].cookie, 'c_user=100200300; xs=abc'); // only facebook cookies
    assert.equal(seen[0].ua, 'Mozilla/5.0 Test');
  } finally {
    gs.close(); socks.close(); fs.rmSync(dir, {recursive: true, force: true});
  }
});

test('cookieHeader keeps only facebook cookies, drops unsafe ones', () => {
  assert.equal(cookieHeader([{name: 'c_user', value: '1', domain: '.facebook.com'}, {name: 'x', value: 'y', domain: '.google.com'}, {name: 'bad', value: 'a\r\nb', domain: '.facebook.com'}]), 'c_user=1');
});
