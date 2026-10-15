import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publishPreview, goLive } from '../src/pages.mjs';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const tmp = (p) => mkdtempSync(join(tmpdir(), p));
function bare() {
  const dir = tmp('cl-remote-');
  execFileSync('git', ['init', '-q', '--bare', dir]);
  return dir;
}
function site(text, extra = {}) {
  const dir = tmp('cl-build-');
  writeFileSync(join(dir, 'index.html'), text);
  for (const [k, v] of Object.entries(extra)) {
    mkdirSync(join(dir, k, '..'), { recursive: true });
    writeFileSync(join(dir, k), v);
  }
  return dir;
}
function read(remote, branch = 'gh-pages') {
  const dir = tmp('cl-read-');
  execFileSync('git', ['clone', '-q', '-b', branch, remote, dir]);
  return (p) => (existsSync(join(dir, p)) ? readFileSync(join(dir, p), 'utf8') : null);
}

test('first preview creates the branch, c/<sha>/, a placeholder root and .nojekyll', async () => {
  const remote = bare();
  const r = await publishPreview({ remote, sha: A, buildDir: site('A', { 'css/x.css': 'x' }), meta: { light: 'lit' } });
  assert.equal(r.path, `c/${A}/`);
  const f = read(remote);
  assert.equal(f(`c/${A}/index.html`), 'A');
  assert.equal(f(`c/${A}/css/x.css`), 'x');
  assert.equal(JSON.parse(f(`c/${A}/commit-live.json`)).light, 'lit');
  assert.match(f('index.html'), /No commit is live yet/);
  assert.equal(f('.nojekyll'), '');
});

test('go-live copies c/<sha>/ to the root and keeps every preview', async () => {
  const remote = bare();
  await publishPreview({ remote, sha: A, buildDir: site('A', { 'old.txt': 'only in A' }) });
  await publishPreview({ remote, sha: B, buildDir: site('B') });
  await goLive({ remote, sha: A, meta: { light: 'lit', at: '1' } });
  let f = read(remote);
  assert.equal(f('index.html'), 'A');
  assert.equal(f('old.txt'), 'only in A');
  assert.equal(JSON.parse(f('live.json')).sha, A);
  assert.equal(f('commit-live.json'), null);
  const r = await goLive({ remote, sha: B, meta: { light: 'lit', at: '2' } });
  f = read(remote);
  assert.equal(f('index.html'), 'B');
  assert.equal(f('old.txt'), null, 'files of the old live commit are gone from the root');
  assert.deepEqual(r.live.previous, { sha: A, at: '1' });
  assert.equal(f(`c/${A}/index.html`), 'A');
  assert.equal(f(`c/${B}/index.html`), 'B');
});

test('go-live without a preview changes nothing', async () => {
  const remote = bare();
  await publishPreview({ remote, sha: A, buildDir: site('A') });
  await assert.rejects(goLive({ remote, sha: B }), /no preview at c\/b{40}\//);
  assert.match(read(remote)('index.html'), /No commit is live yet/);
});

test('a later preview does not replace what is live', async () => {
  const remote = bare();
  await publishPreview({ remote, sha: A, buildDir: site('A') });
  await goLive({ remote, sha: A });
  await publishPreview({ remote, sha: B, buildDir: site('B') });
  assert.equal(read(remote)('index.html'), 'A');
});

test('bad input', async () => {
  const remote = bare();
  await assert.rejects(async () => publishPreview({ remote, sha: 'abc', buildDir: site('x') }), /40-character/);
  await assert.rejects(
    async () => publishPreview({ remote, sha: A, buildDir: join(tmpdir(), 'nope-cl') }),
    /not a directory/,
  );
  await assert.rejects(async () => publishPreview({ remote, sha: A, buildDir: tmp('cl-empty-') }), /empty/);
});
