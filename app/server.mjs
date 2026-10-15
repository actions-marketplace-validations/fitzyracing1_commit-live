#!/usr/bin/env node
// commit-live GitHub App: webhook server. Healthy but "not configured" until the App's key and secret are set.
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { createGitHub } from '@fitzyracing1/light-core';
import { verifySignature, normalizeKey, installationTokens } from './auth.mjs';
import { createHandlers } from './handlers.mjs';
import { marketplaceEvent, marketplaceLogLine } from './marketplace.mjs';

export function readConfig(env = process.env) {
  const cfg = {
    appId: (env.GITHUB_APP_ID ?? '').trim(),
    privateKey: normalizeKey(env.GITHUB_APP_PRIVATE_KEY ?? ''),
    webhookSecret: env.WEBHOOK_SECRET ?? '',
  };
  const missing = [];
  if (!/^\d+$/.test(cfg.appId)) missing.push('GITHUB_APP_ID');
  if (!cfg.privateKey.includes('PRIVATE KEY')) missing.push('GITHUB_APP_PRIVATE_KEY');
  if (!cfg.webhookSecret) missing.push('WEBHOOK_SECRET');
  return { ...cfg, missing, configured: missing.length === 0 };
}

const MAX_BODY = 25 * 1024 * 1024; // GitHub caps payloads at 25 MB

export function createApp({ config = readConfig(), handlers, log = console.log } = {}) {
  let h = handlers;
  if (!h && config.configured) {
    const tokenFor = installationTokens({ appId: config.appId, privateKey: config.privateKey });
    const ghFor = async (installationId, repo) =>
      createGitHub({ token: await tokenFor(installationId), userAgent: 'commit-live-app', writeRepos: [repo] });
    h = createHandlers({ appId: config.appId, ghFor, tokenFor, log });
  }
  const seen = new Set();
  const send = (res, code, body, type = 'application/json') => {
    res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    res.end(type === 'application/json' ? JSON.stringify(body, null, 2) + '\n' : body);
  };

  return createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (req.method === 'GET' && url.pathname === '/healthz') {
      return send(res, 200, {
        ok: true,
        configured: config.configured,
        appId: config.appId || null,
        missing: config.missing,
      });
    }
    if (req.method === 'GET' && url.pathname === '/') {
      return send(
        res,
        200,
        'commit-live GitHub App\n\nPOST /webhook   GitHub webhooks (X-Hub-Signature-256)\nGET  /healthz   { ok, configured, missing }\n\nSpec: https://github.com/fitzyracing1/commit-live/blob/main/SPEC.md\n',
        'text/plain; charset=utf-8',
      );
    }
    if (url.pathname !== '/webhook') return send(res, 404, { error: 'not found' });
    if (req.method !== 'POST') return send(res, 405, { error: 'POST only' });
    if (!config.configured) return send(res, 503, { error: 'not configured', missing: config.missing });
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) req.destroy();
      else chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      if (!verifySignature(config.webhookSecret, raw, req.headers['x-hub-signature-256']))
        return send(res, 401, { error: 'bad signature' });
      const delivery = String(req.headers['x-github-delivery'] ?? '');
      const event = String(req.headers['x-github-event'] ?? '');
      if (delivery && seen.has(delivery)) return send(res, 200, { duplicate: delivery });
      if (delivery) {
        seen.add(delivery);
        if (seen.size > 5000) seen.delete(seen.values().next().value);
      }
      let payload;
      try {
        payload = JSON.parse(raw.toString('utf8'));
      } catch {
        return send(res, 400, { error: 'body must be JSON' });
      }
      if (event === 'ping') return send(res, 200, { pong: true, zen: payload.zen ?? null });
      if (event === 'marketplace_purchase') {
        // free plan only: nothing to grant or revoke, so log it and say 200
        const m = marketplaceEvent(payload);
        log(`${delivery}: ${marketplaceLogLine(m)}`);
        return send(res, 200, { received: 'marketplace_purchase', action: m.action, account: m.account, plan: m.plan });
      }
      // answer within GitHub's 10 s; do the work after
      send(res, 202, { accepted: event, delivery });
      h.handle(event, payload).then(
        (r) => log(`${event} ${delivery}: ${JSON.stringify(r)}`),
        (e) => log(`${event} ${delivery}: error ${e.message}`),
      );
    });
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const config = readConfig();
  const port = Number(process.env.PORT ?? 3000);
  createApp({ config }).listen(port, '0.0.0.0', () => {
    console.log(
      `commit-live app on :${port} (${config.configured ? `configured, app ${config.appId}` : `not configured; missing ${config.missing.join(', ')}`})`,
    );
  });
}
