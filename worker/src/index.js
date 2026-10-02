// Default (prod) Apps Script web-app; a per-worker GAS_WEBHOOK_URL var overrides
// it so the same code serves both the prod and the Claude-sandbox worker.
const DEFAULT_GAS_WEBHOOK_URL =
  'https://script.google.com/macros/s/AKfycbxHwc-vrZjEkD-7V0ud6RNA4132Xma_9VyS3TvjP-I1WfyWqMpU8paTkWPHhHRuB2OycA/exec';

export default {
  async fetch(request, env, context) {
    const url = new URL(request.url);
    const GAS_WEBHOOK_URL = (env && env.GAS_WEBHOOK_URL) || DEFAULT_GAS_WEBHOOK_URL;

    if (request.method === 'GET' && url.pathname === '/health') {
      return Response.json({ok: true, service: 'js-crm-telegram'});
    }

    if (request.method !== 'POST') {
      return new Response('Not found', {status: 404});
    }

    // The path contains the existing Apps Script webhook secret. It never
    // appears in source code or Worker configuration.
    const secret = url.pathname.replace(/^\/+|\/+$/g, '');
    if (!secret || secret.length < 32 || !/^[A-Za-z0-9_-]+$/.test(secret)) {
      return new Response('Not found', {status: 404});
    }

    const contentType = request.headers.get('content-type') || 'application/json';
    const body = await request.arrayBuffer();
    const target = GAS_WEBHOOK_URL + '?secret=' + encodeURIComponent(secret);

    // Telegram receives HTTP 200 immediately. Apps Script continues processing
    // in the background, following Google's redirect internally.
    context.waitUntil(
      fetch(target, {
        method: 'POST',
        headers: {'content-type': contentType},
        body,
        redirect: 'follow'
      }).then(function (response) {
        return response.arrayBuffer();
      }).catch(function (error) {
        console.error('Apps Script forwarding failed', error && error.message);
      })
    );

    return Response.json({ok: true});
  }
};
