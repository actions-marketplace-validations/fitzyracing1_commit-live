import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LightError } from '@fitzyracing1/light-core';
import { runTests, statusFor, lightFromStatuses } from '../src/light.mjs';

test('exit 0 is lit, any other exit code is dark', () => {
  assert.deepEqual(runTests('exit 0'), { exitCode: 0, light: 'lit' });
  assert.deepEqual(runTests('exit 3'), { exitCode: 3, light: 'dark' });
});

test('an empty test command is an error, not dark', () => {
  assert.throws(() => runTests('  '), LightError);
});

test('a killed test command is dark', () => {
  const r = runTests('x', { spawn: () => ({ status: null, signal: 'SIGKILL' }) });
  assert.deepEqual(r, { exitCode: 1, light: 'dark' });
});

test('commit status: lit → success, dark → failure, lit/dark words only', () => {
  const lit = statusFor('lit', { command: 'npm test', exitCode: 0, targetUrl: 'u' });
  assert.deepEqual(lit, {
    state: 'success',
    context: 'commit-live',
    description: '● lit: `npm test` exited 0',
    target_url: 'u',
  });
  const dark = statusFor('dark', { command: 'npm test', exitCode: 1 });
  assert.equal(dark.state, 'failure');
  assert.equal(dark.description, '○ dark: `npm test` exited 1');
  assert.ok(!('target_url' in dark));
});

const st = (state, at, context = 'commit-live') => ({ state, context, created_at: at });

test('reading the light back: newest commit-live status wins', () => {
  const r = lightFromStatuses([
    st('failure', '2026-10-15T01:00:00Z'),
    st('success', '2026-10-15T02:00:00Z'),
    st('failure', '2026-10-15T03:00:00Z', 'other'),
  ]);
  assert.equal(r.light, 'lit');
  assert.equal(lightFromStatuses([st('error', '2026-10-15T01:00:00Z')]).light, 'dark');
});

test('no commit-live status, or a pending one, is no light (an error, never dark)', () => {
  assert.throws(
    () => lightFromStatuses([]),
    (e) => e.code === 'no-run',
  );
  assert.throws(
    () => lightFromStatuses([st('success', 't', 'ci')]),
    (e) => e.code === 'no-run',
  );
  assert.throws(
    () => lightFromStatuses([st('pending', '2026-10-15T01:00:00Z')]),
    (e) => e.code === 'not-completed',
  );
});

test('app check: only the app’s own completed check counts', async () => {
  const { lightFromAppCheck } = await import('../src/light.mjs');
  const c = (conclusion, id = 5337969, status = 'completed') => ({
    name: 'commit-live',
    app: { id },
    status,
    conclusion,
  });
  assert.equal(lightFromAppCheck([c('success')], '5337969').light, 'lit');
  assert.equal(lightFromAppCheck([c('failure')], '5337969').light, 'dark');
  assert.throws(
    () => lightFromAppCheck([c('success', 1)], '5337969'),
    (e) => e.code === 'no-run',
  );
  assert.throws(
    () => lightFromAppCheck([c(null, 5337969, 'in_progress')], '5337969'),
    (e) => e.code === 'not-completed',
  );
});
