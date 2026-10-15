// The Pages branch layout (see SPEC.md):
//   c/<sha>/                    one preview per lit commit, never overwritten by go-live
//   c/<sha>/commit-live.json    { sha, light, bit, run, at }
//   index.html + rest of root   a copy of the live commit's preview
//   live.json                   { sha, light, at, previous }
//   .nojekyll
import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

export const SHA = /^[0-9a-f]{40}$/;
const KEEP_AT_ROOT = new Set(['.git', 'c', '.nojekyll']);

const PLACEHOLDER = `<!doctype html><meta charset="utf-8"><title>commit-live</title>
<p>○ No commit is live yet. Previews are under <code>c/&lt;sha&gt;/</code>; run go-live with a lit sha.</p>
`;

export function checkSha(sha) {
  if (!SHA.test(String(sha))) throw new Error(`need a full 40-character commit sha, got ${JSON.stringify(sha)}`);
  return sha;
}

function git(dir, args, { auth } = {}) {
  const pre = auth ? ['-c', `http.extraheader=AUTHORIZATION: basic ${auth}`] : [];
  return execFileSync('git', [...pre, ...args], {
    cwd: dir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

export const basicAuth = (token) => (token ? Buffer.from(`x-access-token:${token}`).toString('base64') : null);

// Fresh shallow checkout of the pages branch (or a new orphan branch) in a temp dir.
function checkout(remote, branch, auth) {
  const dir = mkdtempSync(join(tmpdir(), 'commit-live-'));
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.name', 'commit-live']);
  git(dir, ['config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com']);
  git(dir, ['remote', 'add', 'origin', remote]);
  let exists = true;
  try {
    git(dir, ['fetch', '-q', '--depth=1', 'origin', branch], { auth });
  } catch (e) {
    if (!/couldn't find remote ref|not our ref|no such ref/i.test(String(e.stderr ?? e.message))) throw e;
    exists = false;
  }
  if (exists) git(dir, ['checkout', '-q', '-B', branch, 'FETCH_HEAD']);
  else git(dir, ['checkout', '-q', '--orphan', branch]);
  return dir;
}

// Change the branch with `edit(dir)` and push; on a race with another job, start over (up to `tries`).
async function update({ remote, branch = 'gh-pages', token, message, edit, tries = 5 }) {
  const auth = basicAuth(token);
  for (let attempt = 1; ; attempt++) {
    const dir = checkout(remote, branch, auth);
    try {
      const result = await edit(dir);
      if (!existsSync(join(dir, '.nojekyll'))) writeFileSync(join(dir, '.nojekyll'), '');
      git(dir, ['add', '-A']);
      if (!git(dir, ['status', '--porcelain'])) return { ...result, changed: false };
      git(dir, ['commit', '-q', '-m', message]);
      try {
        git(dir, ['push', '-q', 'origin', `HEAD:refs/heads/${branch}`], { auth });
        return { ...result, changed: true, commit: git(dir, ['rev-parse', 'HEAD']) };
      } catch (e) {
        if (
          attempt >= tries ||
          !/rejected|fetch first|non-fast-forward|failed to push/i.test(String(e.stderr ?? e.message))
        )
          throw e;
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

function copyDir(from, to, skip = () => false) {
  mkdirSync(to, { recursive: true });
  for (const name of readdirSync(from)) {
    if (name === '.git' || skip(name)) continue;
    cpSync(join(from, name), join(to, name), { recursive: true });
  }
}

// Publish buildDir as the preview of `sha` under c/<sha>/.
export function publishPreview({ remote, branch, token, sha, buildDir, meta = {} }) {
  checkSha(sha);
  const src = resolve(buildDir);
  if (!existsSync(src) || !statSync(src).isDirectory()) throw new Error(`build-dir ${buildDir} is not a directory`);
  if (!readdirSync(src).length) throw new Error(`build-dir ${buildDir} is empty`);
  return update({
    remote,
    branch,
    token,
    message: `preview ${sha.slice(0, 7)}`,
    edit(dir) {
      const dest = join(dir, 'c', sha);
      rmSync(dest, { recursive: true, force: true });
      copyDir(src, dest);
      writeFileSync(join(dest, 'commit-live.json'), JSON.stringify({ sha, ...meta }, null, 2) + '\n');
      if (!existsSync(join(dir, 'index.html')) && !existsSync(join(dir, 'live.json')))
        writeFileSync(join(dir, 'index.html'), PLACEHOLDER);
      return { path: `c/${sha}/` };
    },
  });
}

// Point the root at c/<sha>/. The caller must already have checked that the commit is lit.
export function goLive({ remote, branch, token, sha, meta = {} }) {
  checkSha(sha);
  return update({
    remote,
    branch,
    token,
    message: `go live ${sha.slice(0, 7)}`,
    edit(dir) {
      const preview = join(dir, 'c', sha);
      if (!existsSync(preview))
        throw new Error(`no preview at c/${sha}/ on ${branch}; a lit commit needs a preview before it can go live`);
      const previousPath = join(dir, 'live.json');
      const previous = existsSync(previousPath) ? JSON.parse(readFileSync(previousPath, 'utf8')) : null;
      for (const name of readdirSync(dir))
        if (!KEEP_AT_ROOT.has(name)) rmSync(join(dir, name), { recursive: true, force: true });
      copyDir(preview, dir, (name) => KEEP_AT_ROOT.has(name) || name === 'commit-live.json');
      const live = { sha, ...meta, previous: previous ? { sha: previous.sha, at: previous.at } : null };
      writeFileSync(previousPath, JSON.stringify(live, null, 2) + '\n');
      return { live };
    },
  });
}
