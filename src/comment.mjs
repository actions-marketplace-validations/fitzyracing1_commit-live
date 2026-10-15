// The PR comment: one per PR, updated in place on each push.
import { lamp, toBit } from '@fitzyracing1/light-core';

export const MARKER = '<!-- commit-live -->';

export function commentBody({ sha, light, command, exitCode, runUrl, previewUrl, liveUrl }) {
  const short = sha.slice(0, 7);
  const lines = [
    MARKER,
    `### ${lamp(light)} ${light} · \`${short}\``,
    '',
    `| | |`,
    `|---|---|`,
    `| light | **${light}** (bit ${toBit(light)}) |`,
    `| test | \`${command}\` exited ${exitCode} |`,
    `| run | ${runUrl} |`,
    `| preview | ${previewUrl ? previewUrl : light === 'lit' ? 'not deployed' : 'none: only lit commits get a preview'} |`,
  ];
  if (liveUrl)
    lines.push(
      `| go live | ${light === 'lit' ? `run the go-live workflow with sha \`${sha}\`; then ${liveUrl}` : 'refused while dark'} |`,
    );
  lines.push(
    '',
    '<sub>[commit-live](https://github.com/fitzyracing1/commit-live): lit = 0, dark = 1. Only a lit commit can go live.</sub>',
  );
  return lines.join('\n');
}

// Create or update the one commit-live comment on a PR.
export async function upsertComment(gh, repo, pr, body) {
  const comments = await gh.get(`/repos/${repo}/issues/${pr}/comments?per_page=100`);
  const mine = (comments ?? []).find((c) => typeof c.body === 'string' && c.body.startsWith(MARKER));
  if (mine) return gh.write('PATCH', `/repos/${repo}/issues/comments/${mine.id}`, { body });
  return gh.write('POST', `/repos/${repo}/issues/${pr}/comments`, { body });
}
