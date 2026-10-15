// The App's light for a commit: every push / pull_request workflow run on that sha, latest attempt each.
// Lit only when all of them are lit (light-core: only success is lit). No run = no light yet (never dark).
import { lightOfRun, LIT, DARK } from '@fitzyracing1/light-core';

export const CHECK_NAME = 'commit-live';
const EVENTS = new Set(['push', 'pull_request']);

export function lightFromWorkflowRuns(runs) {
  const byWorkflowEvent = new Map();
  for (const r of runs ?? []) {
    if (!EVENTS.has(r.event)) continue;
    const key = `${r.workflow_id}:${r.event}`;
    const seen = byWorkflowEvent.get(key);
    const newer =
      !seen ||
      Date.parse(r.run_started_at ?? r.created_at) > Date.parse(seen.run_started_at ?? seen.created_at) ||
      (r.id === seen.id && (r.run_attempt ?? 1) > (seen.run_attempt ?? 1));
    if (newer) byWorkflowEvent.set(key, r);
  }
  const relevant = [...byWorkflowEvent.values()].sort((a, b) => String(a.name).localeCompare(String(b.name)));
  if (!relevant.length) return { state: 'none', runs: [] };
  if (relevant.some((r) => r.status !== 'completed')) return { state: 'waiting', runs: relevant };
  const lights = relevant.map((r) => ({ run: r, light: lightOfRun(r) }));
  return { state: lights.every((l) => l.light === LIT) ? LIT : DARK, runs: relevant, lights };
}

export function checkOutput(result, extra = '') {
  const rows = result.runs.map(
    (r) =>
      `| ${r.status === 'completed' ? (r.conclusion === 'success' ? '● lit' : '○ dark') : '◌ waiting'} | [${r.name}](${r.html_url}) | ${r.event} | ${r.conclusion ?? r.status} |`,
  );
  const table = rows.length ? `| light | workflow | event | result |\n|---|---|---|---|\n${rows.join('\n')}\n` : '';
  const title = {
    lit: '● lit',
    dark: '○ dark',
    waiting: '◌ waiting for workflow runs',
    none: '◌ no workflow run yet, so no light',
  }[result.state];
  const summary = {
    lit: 'Every push / pull_request workflow run on this commit is lit. **Go live** points the Pages root at this commit.',
    dark: 'At least one workflow run on this commit is dark. A dark commit cannot go live.',
    waiting: 'The light is set when every workflow run on this commit has finished.',
    none: 'No push or pull_request workflow run on this commit yet. No data is not a light.',
  }[result.state];
  return { title, summary: summary + (extra ? `\n\n${extra}` : ''), text: table || undefined };
}
