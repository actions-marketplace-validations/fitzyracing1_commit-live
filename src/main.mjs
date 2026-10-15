// commit-live action entry. Modes: check (push / pull_request) and go-live (workflow_dispatch).
import { appendFileSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createGitHub, LightError, toBit, lamp } from '@fitzyracing1/light-core';
import { runTests, statusFor, lightFromStatuses, lightFromAppCheck, CONTEXT } from './light.mjs';
import { commentBody, upsertComment } from './comment.mjs';
import { publishPreview, goLive, checkSha } from './pages.mjs';

export function readInputs(env = process.env) {
  const input = (name, fallback = '') => {
    const v = env[`INPUT_${name.toUpperCase().replace(/[ -]/g, '_')}`];
    return v === undefined || v === '' ? fallback : v.trim();
  };
  return {
    mode: input('mode', 'check'),
    testCommand: input('test-command', 'npm test'),
    buildCommand: input('build-command'),
    buildDir: input('build-dir'),
    preview: input('preview', 'lit'),
    sha: input('sha'),
    pagesBranch: input('pages-branch', 'gh-pages'),
    pagesUrl: input('pages-url'),
    comment: input('comment', 'true') === 'true',
    failOnDark: input('fail-on-dark', 'true') === 'true',
    appId: input('app-id'),
    token: input('token') || env.GITHUB_TOKEN || '',
  };
}

export function context(env = process.env, readEvent = (p) => JSON.parse(readFileSync(p, 'utf8'))) {
  const event = env.GITHUB_EVENT_PATH ? readEvent(env.GITHUB_EVENT_PATH) : {};
  const repo = env.GITHUB_REPOSITORY;
  const pr = event.pull_request ?? null;
  const server = env.GITHUB_SERVER_URL || 'https://github.com';
  return {
    repo,
    eventName: env.GITHUB_EVENT_NAME,
    // a PR's light belongs to its head commit, not the temporary merge commit
    sha: pr ? pr.head.sha : env.GITHUB_SHA,
    pr: pr ? pr.number : null,
    fromFork: pr ? pr.head.repo?.full_name !== repo : false,
    runUrl: `${server}/${repo}/actions/runs/${env.GITHUB_RUN_ID}`,
    remote: `${server}/${repo}.git`,
    defaultPagesUrl: (() => {
      const [owner, name] = String(repo).split('/');
      return name?.toLowerCase() === `${owner?.toLowerCase()}.github.io`
        ? `https://${name}/`
        : `https://${owner}.github.io/${name}/`;
    })(),
  };
}

function out(env, values) {
  if (env.GITHUB_OUTPUT)
    appendFileSync(
      env.GITHUB_OUTPUT,
      Object.entries(values)
        .map(([k, v]) => `${k}=${v ?? ''}\n`)
        .join(''),
    );
}
function summary(env, md) {
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, md + '\n');
}

export async function check({
  inputs,
  ctx,
  gh,
  env = process.env,
  log = console.log,
  run = runTests,
  publish = publishPreview,
  sh = spawnSync,
}) {
  log(`commit-live: testing ${ctx.sha} with: ${inputs.testCommand}`);
  const { exitCode, light } = run(inputs.testCommand);
  log(`commit-live: ${lamp(light)} ${light} (exit ${exitCode})`);

  const pagesUrl = (inputs.pagesUrl || ctx.defaultPagesUrl).replace(/\/?$/, '/');
  let previewUrl = null;
  let previewError = null;
  const wantPreview = inputs.buildDir && (inputs.preview === 'always' || (inputs.preview === 'lit' && light === 'lit'));
  if (wantPreview && ctx.fromFork) log('commit-live: PR from a fork; the token cannot write Pages, so no preview');
  else if (wantPreview) {
    try {
      if (inputs.buildCommand) {
        const b = sh(inputs.buildCommand, {
          shell: process.platform === 'win32' ? true : '/bin/bash',
          stdio: 'inherit',
        });
        if (b.status !== 0) throw new Error(`build-command exited ${b.status}`);
      }
      await publish({
        remote: ctx.remote,
        branch: inputs.pagesBranch,
        token: inputs.token,
        sha: ctx.sha,
        buildDir: inputs.buildDir,
        meta: { light, bit: toBit(light), run: ctx.runUrl, at: new Date().toISOString() },
      });
      previewUrl = `${pagesUrl}c/${ctx.sha}/`;
      log(`commit-live: preview ${previewUrl}`);
    } catch (e) {
      // a preview that could not deploy doesn't change the light; it is reported as an error
      previewError = e.message;
      log(`::error::commit-live preview failed (the light is still ${light}): ${e.message}`);
    }
  }

  await gh.write(
    'POST',
    `/repos/${ctx.repo}/statuses/${ctx.sha}`,
    statusFor(light, { command: inputs.testCommand, exitCode, targetUrl: previewUrl || ctx.runUrl }),
  );
  if (ctx.pr && inputs.comment && !ctx.fromFork) {
    await upsertComment(
      gh,
      ctx.repo,
      ctx.pr,
      commentBody({
        sha: ctx.sha,
        light,
        command: inputs.testCommand,
        exitCode,
        runUrl: ctx.runUrl,
        previewUrl,
        liveUrl: pagesUrl,
      }),
    );
  }
  out(env, { light, bit: toBit(light), 'preview-url': previewUrl, sha: ctx.sha });
  summary(
    env,
    `### ${lamp(light)} ${light} · \`${ctx.sha.slice(0, 7)}\`\n\n- test: \`${inputs.testCommand}\` exited ${exitCode}\n- preview: ${previewUrl ?? (previewError ? `error: ${previewError}` : 'none')}`,
  );
  if (previewError) return 2;
  return light === 'dark' && inputs.failOnDark ? 1 : 0;
}

export async function resolveSha(gh, repo, sha) {
  if (!sha) throw new Error('go-live needs the sha input');
  if (/^[0-9a-f]{40}$/.test(sha)) return sha;
  if (!/^[0-9a-f]{7,39}$/.test(sha)) throw new Error(`sha must be a commit sha, got ${JSON.stringify(sha)}`);
  return (await gh.get(`/repos/${repo}/commits/${sha}`)).sha;
}

export async function goLiveMode({ inputs, ctx, gh, env = process.env, log = console.log, live = goLive }) {
  const sha = checkSha(await resolveSha(gh, ctx.repo, inputs.sha));
  let light;
  try {
    if (inputs.appId) {
      // trust only the commit-live GitHub App's own check run (SPEC.md section 7)
      const q = `check_name=${CONTEXT}&app_id=${inputs.appId}&filter=latest`;
      const { check_runs: runs = [] } = await gh.get(`/repos/${ctx.repo}/commits/${sha}/check-runs?${q}`);
      ({ light } = lightFromAppCheck(runs, inputs.appId));
    } else {
      const statuses = await gh.get(`/repos/${ctx.repo}/commits/${sha}/statuses?per_page=100`);
      ({ light } = lightFromStatuses(statuses));
    }
  } catch (e) {
    if (!(e instanceof LightError)) throw e;
    log(`::error::commit-live refused go-live for ${sha}: ${e.message}`);
    summary(env, `### go-live refused · \`${sha.slice(0, 7)}\`\n\n${e.message}`);
    out(env, { light: '', sha, 'live-url': '' });
    return 1;
  }
  if (light !== 'lit') {
    log(`::error::commit-live refused go-live: ${sha} is ○ dark. Only a lit commit can go live.`);
    summary(
      env,
      `### go-live refused · \`${sha.slice(0, 7)}\` is ○ dark\n\nOnly a lit commit can go live. Nothing changed.`,
    );
    out(env, { light, sha, 'live-url': '' });
    return 1;
  }
  const pagesUrl = (inputs.pagesUrl || ctx.defaultPagesUrl).replace(/\/?$/, '/');
  const r = await live({
    remote: ctx.remote,
    branch: inputs.pagesBranch,
    token: inputs.token,
    sha,
    meta: { light, bit: 0, run: ctx.runUrl, at: new Date().toISOString() },
  });
  log(`commit-live: ● ${sha} is live at ${pagesUrl}${r.changed ? '' : ' (it already was)'}`);
  await gh.write('POST', `/repos/${ctx.repo}/statuses/${sha}`, {
    state: 'success',
    context: `${CONTEXT}/live`,
    description: '● lit and live at the Pages root',
    target_url: pagesUrl,
  });
  out(env, { light, sha, 'live-url': pagesUrl });
  summary(
    env,
    `### ● live · \`${sha.slice(0, 7)}\`\n\n${pagesUrl} now serves this lit commit (preview: ${pagesUrl}c/${sha}/).`,
  );
  return 0;
}

export async function main(env = process.env) {
  const inputs = readInputs(env);
  const ctx = context(env);
  const gh = createGitHub({ token: inputs.token, userAgent: 'commit-live', writeRepos: [ctx.repo] });
  if (inputs.mode === 'check') return check({ inputs, ctx, gh, env });
  if (inputs.mode === 'go-live') return goLiveMode({ inputs, ctx, gh, env });
  throw new Error(`mode must be check or go-live, got ${JSON.stringify(inputs.mode)}`);
}
