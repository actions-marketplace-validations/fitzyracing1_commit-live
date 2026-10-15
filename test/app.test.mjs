import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, createVerify, generateKeyPairSync } from 'node:crypto';
import { verifySignature, appJwt, normalizeKey } from '../app/auth.mjs';
import { lightFromWorkflowRuns } from '../app/light.mjs';
import { createHandlers, GO_LIVE } from '../app/handlers.mjs';
import { createApp, readConfig } from '../app/server.mjs';

const APP = 5337969;
const A = 'a'.repeat(40);
const sign = (secret, body) => 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');

test('webhook signature: right secret only', () => {
  const body = Buffer.from('{"x":1}');
  assert.ok(verifySignature('s', body, sign('s', body)));
  assert.ok(!verifySignature('s', body, sign('t', body)));
  assert.ok(!verifySignature('s', body, undefined));
  assert.ok(!verifySignature('', body, sign('', body)), 'no secret, nothing verifies');
});

test('app JWT is RS256 and verifies with the public key', () => {
  // a throwaway key made for this test only; the App's real key is created in the App settings
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = privateKey.export({ type: 'pkcs1', format: 'pem' });
  const jwt = appJwt(APP, pem, 1_000_000_000);
  const [h, p, s] = jwt.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(h, 'base64url')), { alg: 'RS256', typ: 'JWT' });
  assert.deepEqual(JSON.parse(Buffer.from(p, 'base64url')), { iat: 999_940, exp: 1_000_480, iss: String(APP) });
  assert.ok(createVerify('RSA-SHA256').update(`${h}.${p}`).verify(publicKey, Buffer.from(s, 'base64url')));
  assert.equal(normalizeKey(pem.replace(/\n/g, '\\n')), pem.trim());
  assert.equal(normalizeKey(Buffer.from(pem).toString('base64')), pem.trim());
});

const wr = (id, workflow_id, conclusion, extra = {}) => ({
  id,
  workflow_id,
  name: `wf${workflow_id}`,
  event: 'push',
  status: 'completed',
  conclusion,
  html_url: `u/${id}`,
  created_at: '2026-10-15T00:00:00Z',
  ...extra,
});

test('light from workflow runs: all lit → lit; any dark → dark; running → waiting; none → no light', () => {
  assert.equal(lightFromWorkflowRuns([wr(1, 1, 'success'), wr(2, 2, 'success')]).state, 'lit');
  assert.equal(lightFromWorkflowRuns([wr(1, 1, 'success'), wr(2, 2, 'cancelled')]).state, 'dark');
  assert.equal(
    lightFromWorkflowRuns([wr(1, 1, 'success'), wr(2, 2, null, { status: 'in_progress' })]).state,
    'waiting',
  );
  assert.equal(lightFromWorkflowRuns([]).state, 'none');
  assert.equal(lightFromWorkflowRuns([wr(1, 1, 'success', { event: 'workflow_dispatch' })]).state, 'none');
  // a re-run attempt replaces the first attempt
  assert.equal(lightFromWorkflowRuns([wr(1, 1, 'failure'), wr(1, 1, 'success', { run_attempt: 2 })]).state, 'lit');
});

function fakeGh({ runs = [], checks = [], check = null, permission = 'write' } = {}) {
  const writes = [];
  return {
    writes,
    get: async (p) => {
      if (p.includes('/check-runs?')) return { check_runs: checks };
      if (/\/check-runs\/\d+$/.test(p)) return check;
      if (p.includes('/actions/runs?')) return { workflow_runs: runs };
      if (p.includes('/permission')) return { permission };
      if (p.endsWith('/pages')) return { html_url: 'https://o.github.io/r/' };
      throw new Error(p);
    },
    write: async (m, p, b) => {
      writes.push([m, p, b]);
      return { id: 77 };
    },
  };
}
const handlersWith = (gh, goLive = async () => ({})) =>
  createHandlers({
    appId: APP,
    ghFor: async () => gh,
    tokenFor: async () => 'tok',
    goLive,
    log: () => {},
    now: () => new Date('2026-10-15T00:00:00Z'),
  });
const base = { repository: { full_name: 'o/r' }, installation: { id: 9 } };

test('push creates the commit-live check; waiting until runs finish', async () => {
  const gh = fakeGh({ runs: [wr(1, 1, null, { status: 'in_progress' })] });
  const r = await handlersWith(gh).handle('push', { ...base, after: A });
  assert.equal(r.state, 'waiting');
  const [m, p, b] = gh.writes[0];
  assert.deepEqual(
    [m, p, b.name, b.head_sha, b.status],
    ['POST', '/repos/o/r/check-runs', 'commit-live', A, 'in_progress'],
  );
  assert.deepEqual(b.actions, []);
});

test('lit commit: check completes success with a Go live button; dark gets none', async () => {
  let gh = fakeGh({ runs: [wr(1, 1, 'success')], checks: [{ id: 5, name: 'commit-live', app: { id: APP } }] });
  await handlersWith(gh).handle('workflow_run', { ...base, action: 'completed', workflow_run: { head_sha: A } });
  const [m, p, b] = gh.writes[0];
  assert.deepEqual(
    [m, p, b.status, b.conclusion, b.output.title],
    ['PATCH', '/repos/o/r/check-runs/5', 'completed', 'success', '● lit'],
  );
  assert.deepEqual(b.actions, [GO_LIVE]);
  gh = fakeGh({ runs: [wr(1, 1, 'failure')] });
  await handlersWith(gh).handle('pull_request', { ...base, action: 'synchronize', pull_request: { head: { sha: A } } });
  const b2 = gh.writes[0][2];
  assert.deepEqual([b2.conclusion, b2.output.title, b2.actions], ['failure', '○ dark', []]);
});

test('a deleted branch and other events are ignored', async () => {
  const h = handlersWith(fakeGh());
  assert.ok((await h.handle('push', { ...base, deleted: true, after: '0'.repeat(40) })).ignored);
  assert.ok((await h.handle('issues', base)).ignored);
});

const goLivePayload = (extra = {}) => ({
  ...base,
  action: 'requested_action',
  requested_action: { identifier: 'go-live' },
  sender: { login: 'joshua' },
  check_run: { id: 5, app: { id: APP }, head_sha: A },
  ...extra,
});
const ownCheck = (conclusion, extra = {}) => ({
  id: 5,
  name: 'commit-live',
  app: { id: APP },
  head_sha: A,
  status: 'completed',
  conclusion,
  html_url: 'c',
  ...extra,
});

test('Go live on a lit check: goLive runs with the installation token', async () => {
  const calls = [];
  const gh = fakeGh({ check: ownCheck('success'), checks: [ownCheck('success')] });
  const r = await handlersWith(gh, async (o) => calls.push(o)).handle('check_run', goLivePayload());
  assert.deepEqual(r, { live: true, sha: A, url: 'https://o.github.io/r/' });
  assert.deepEqual([calls[0].sha, calls[0].token, calls[0].remote], [A, 'tok', 'https://github.com/o/r.git']);
  assert.equal(gh.writes[0][2].output.title, '● lit and live');
});

test('Go live is refused for a dark check, another app’s check, a stale check, or no write access', async () => {
  const cases = [
    [fakeGh({ check: ownCheck('failure'), checks: [ownCheck('failure')] }), /not lit/],
    [fakeGh({ check: ownCheck('success', { app: { id: 1 } }) }), /not this app/],
    [fakeGh({ check: ownCheck('success'), checks: [ownCheck('success', { id: 6 })] }), /newer/],
    [fakeGh({ check: ownCheck('success'), checks: [ownCheck('success')], permission: 'read' }), /write access/],
  ];
  for (const [gh, why] of cases) {
    let went = 0;
    const r = await handlersWith(gh, async () => went++).handle('check_run', goLivePayload());
    assert.equal(r.live, false);
    assert.match(r.reason, why);
    assert.equal(went, 0);
  }
});

test('config: not configured until id, key and secret are all set', () => {
  assert.deepEqual(readConfig({ GITHUB_APP_ID: '5337969' }).missing, ['GITHUB_APP_PRIVATE_KEY', 'WEBHOOK_SECRET']);
  assert.equal(readConfig({}).configured, false);
});

async function serve(app) {
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${app.address().port}`, close: () => app.close() };
}

test('server not configured: /healthz is healthy and says so; /webhook answers 503', async () => {
  const s = await serve(createApp({ config: readConfig({ GITHUB_APP_ID: '5337969' }), log: () => {} }));
  try {
    const h = await (await fetch(`${s.url}/healthz`)).json();
    assert.deepEqual([h.ok, h.configured, h.appId], [true, false, '5337969']);
    assert.equal((await fetch(`${s.url}/webhook`, { method: 'POST', body: '{}' })).status, 503);
  } finally {
    s.close();
  }
});

test('server configured: signature checked, ping answered, events accepted and handled', async () => {
  const handled = [];
  const config = { configured: true, missing: [], appId: String(APP), webhookSecret: 'shh', privateKey: 'x' };
  const s = await serve(
    createApp({ config, handlers: { handle: async (e, p) => handled.push([e, p]) }, log: () => {} }),
  );
  const post = (event, body, sig = sign('shh', body), delivery = event) =>
    fetch(`${s.url}/webhook`, {
      method: 'POST',
      body,
      headers: { 'x-github-event': event, 'x-hub-signature-256': sig, 'x-github-delivery': delivery },
    });
  try {
    assert.equal((await post('push', '{}', 'sha256=bad')).status, 401);
    assert.equal((await post('ping', '{"zen":"z"}')).status, 200);
    assert.equal((await post('push', '{"after":"x"}', undefined, 'd1')).status, 202);
    assert.equal((await post('push', '{"after":"x"}', undefined, 'd1')).status, 200, 'duplicate delivery');
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(handled, [['push', { after: 'x' }]]);
  } finally {
    s.close();
  }
});

test('marketplace_purchase: every action is verified, logged with account and plan, and answered 200', async () => {
  const { MARKETPLACE_ACTIONS } = await import('../app/marketplace.mjs');
  const logs = [];
  const handled = [];
  const config = { configured: true, missing: [], appId: String(APP), webhookSecret: 'shh', privateKey: 'x' };
  const s = await serve(
    createApp({ config, handlers: { handle: async (e) => handled.push(e) }, log: (l) => logs.push(l) }),
  );
  const purchase = (action) =>
    JSON.stringify({
      action,
      effective_date: '2026-10-16T00:00:00Z',
      marketplace_purchase: {
        account: { login: 'octo-org', id: 42, type: 'Organization' },
        plan: { id: 7, name: 'Free', price_model: 'FREE' },
      },
      ...(action === 'changed' ? { previous_marketplace_purchase: { plan: { name: 'Old' } } } : {}),
    });
  const post = (body, sig = sign('shh', body), delivery = String(Math.random())) =>
    fetch(`${s.url}/webhook`, {
      method: 'POST',
      body,
      headers: { 'x-github-event': 'marketplace_purchase', 'x-hub-signature-256': sig, 'x-github-delivery': delivery },
    });
  try {
    for (const action of MARKETPLACE_ACTIONS) {
      const r = await post(purchase(action));
      assert.equal(r.status, 200, action);
      assert.deepEqual(await r.json(), { received: 'marketplace_purchase', action, account: 'octo-org', plan: 'Free' });
    }
    assert.equal((await post(purchase('purchased'), 'sha256=forged')).status, 401);
    assert.equal(logs.length, MARKETPLACE_ACTIONS.length);
    assert.match(
      logs[0],
      /marketplace_purchase\.purchased: Organization octo-org \(42\) plan Free \(7, FREE\) effective 2026-10-16/,
    );
    assert.match(logs[1], /\.changed: .*\(was Old\)/);
    assert.deepEqual(handled, [], 'plan events never reach the check handlers');
  } finally {
    s.close();
  }
});
