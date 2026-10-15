// The light of a commit, from the test command's exit code or from the commit status commit-live posted.
import { spawnSync } from 'node:child_process';
import { lightOfExit, lightOf, toBit, lamp, LightError } from '@fitzyracing1/light-core';

export const CONTEXT = 'commit-live';

// Runs the user's test command in the job's shell. The exit code is the light: 0 lit, anything else dark.
export function runTests(command, { cwd = process.cwd(), env = process.env, spawn = spawnSync } = {}) {
  if (!command || !String(command).trim())
    throw new LightError('bad-value', 'test-command is empty, so there is no light');
  const shell = process.platform === 'win32' ? true : '/bin/bash';
  const r = spawn(command, { cwd, env, shell, stdio: 'inherit' });
  if (r.error) throw r.error;
  // killed by a signal: the tests ran and did not exit 0, so dark
  const exitCode = Number.isInteger(r.status) ? r.status : 1;
  return { exitCode, light: lightOfExit(exitCode) };
}

// Commit status for a light. success/failure are the only states commit-live writes.
export function statusFor(light, { command, exitCode, targetUrl }) {
  const word = `${lamp(light)} ${light}`;
  const description = `${word}: \`${command}\` exited ${exitCode}`.slice(0, 140);
  return {
    state: light === 'lit' ? 'success' : 'failure',
    context: CONTEXT,
    description,
    ...(targetUrl ? { target_url: targetUrl } : {}),
  };
}

// The light a commit has, read back from its commit-live status. No status = no light (an error, never dark).
export function lightFromStatuses(statuses, context = CONTEXT) {
  const mine = (statuses ?? []).filter((s) => s.context === context);
  if (!mine.length) throw new LightError('no-run', `no ${context} status on this commit, so it has no light`);
  mine.sort((a, b) => Date.parse(b.created_at ?? 0) - Date.parse(a.created_at ?? 0));
  const s = mine[0];
  if (s.state === 'pending')
    throw new LightError('not-completed', `${context} is still pending, so there is no light yet`);
  // success → lit; failure and error → dark (lightOf maps every non-success conclusion to dark)
  return { light: lightOf(s.state === 'success' ? 'success' : 'failure'), status: s };
}

export { toBit, lamp };
