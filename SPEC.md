# Live on a commit: the standard (v1)

A commit is the unit that goes live. Every commit has one **light**, and only a **lit** commit can be live.
Nothing is merged to make a commit live: going live means pointing the site at that commit's build.

## 1. The light

- A commit's light comes from one test command run on that exact commit: **exit 0 is lit, any other exit code
  is dark**. A test run that was killed (signal, timeout) is **dark**.
- Active-low, as in [lit-dark SPEC](https://github.com/fitzyracing1/lit-dark/blob/main/SPEC.md):
  lit = bit 0 ●, dark = bit 1 ○. The rule is [light-core](https://github.com/fitzyracing1/light-core) v0.1.0.
- **No data is not a light.** A commit with no recorded light, or whose light is still being computed, has no
  light. That is an error, never dark and never lit.
- For a pull request, the light belongs to the PR's **head commit**, not GitHub's temporary merge commit.

## 2. Where the light is recorded

The light is a GitHub **commit status** on the commit:

| field | lit | dark |
|---|---|---|
| `context` | `commit-live` | `commit-live` |
| `state` | `success` | `failure` |
| `description` | `● lit: \`<cmd>\` exited 0` | `○ dark: \`<cmd>\` exited <n>` |
| `target_url` | the commit's preview | the run |

Reading it back: take the newest `commit-live` status on the commit. `success` is lit; `failure` and `error` are
dark; `pending` or no status is no light. Pull requests also get one comment (starting with `<!-- commit-live -->`)
that is updated in place on every push.

## 3. Previews

- A preview is the static build of one commit, served at `<pages>/c/<full sha>/`.
- By default **only lit commits get a preview** (`preview: lit`); `always` previews dark commits too, `never` turns
  previews off. A preview never changes the light; if it can't deploy, that is reported as an error and the
  light stays what the tests said.
- Previews are never overwritten by going live and stay until someone deletes them from the Pages branch.
- Each preview has `c/<sha>/commit-live.json`: `{ sha, light, bit, run, at }`.
- Site builds must use relative links, so the same files work under `/c/<sha>/` and at the root.

## 4. Going live

`go-live` takes one sha (full, or abbreviated and resolved to the full sha) and:

1. reads the commit's light (section 2);
2. **refuses** if the commit is dark or has no light, and changes nothing;
3. refuses if the commit has no preview;
4. otherwise replaces everything at the Pages root except `c/` and `.nojekyll` with a copy of `c/<sha>/`, and
   writes `live.json`: `{ sha, light, bit, run, at, previous: { sha, at } }`;
5. posts a `commit-live/live` status on the commit that points to the root.

Going live merges nothing, pushes nothing to any code branch, and can point back at an older lit commit
(rollback is go-live with the old sha).

## 5. Pages branch layout

```
gh-pages
├── .nojekyll
├── index.html …          copy of the live commit's preview (a placeholder until the first go-live)
├── live.json             which commit is live
└── c/
    └── <sha>/            one preview per commit
        ├── index.html …
        └── commit-live.json
```

Concurrent jobs: each update is a fresh checkout + commit + push; a rejected push starts over (up to 5 times).

## 6. Permissions and trust

- `check` needs `statuses: write` and `pull-requests: write` (comment). Previews and go-live need `contents: write`
  (the Pages branch). Nothing else, no external service.
- PRs from forks get a light but no preview and no comment (their token is read-only).
- Anyone who can write commit statuses can write a `commit-live` status. Go-live trusts the repository's own
  write access; it doesn't rerun the tests. The GitHub App (section 7) closes this gap.

## 7. The commit-live GitHub App

The App is registered as **commit-live light** (App ID 5337969). Its server is in [app/](app/README.md). It needs the
App's private key and webhook secret to be configured; until then it answers `/healthz` as not configured.

- **Why:** one-click install with no workflow file, checks instead of statuses, a "Go live" button on the check,
  and a light only the app can write.
- **Permissions:** Checks (read & write: the `commit-live` check), Contents (read & write: go-live pushes the `gh-pages` branch;
  also needed for `push` events), Actions (read: workflow runs and `workflow_run` events), Pull requests (read: only so
  GitHub sends `pull_request` events; no pull request API is called), Pages (read: the site URL), Metadata (read:
  the clicker's permission level). No Commit statuses, no write to pull requests, issues or Pages.
  **Events:** `push`, `pull_request`, `check_run` (`requested_action`), `workflow_run`; Marketplace plan events
  (`marketplace_purchase`) are logged and answered 200 (one free plan, nothing gated).
- **Flow:**
  1. On `workflow_run` completed for a workflow named in `.github/commit-live.yml`, the app reads that run's
     conclusion with light-core `lightOfRun()` (only `success` is lit) and writes a check run named `commit-live`
     on the head sha: conclusion `success` (● lit) or `failure` (○ dark).
  2. The check run has a **Go live** action button only when lit. `requested_action` re-reads the light, and
     only if it is still lit, calls the same `goLive()` as the Action (or triggers the repo's go-live workflow).
  3. Previews keep the same `c/<sha>/` layout so the Action and the App are interchangeable.
- **Trust:** go-live reads the app's own check run (`app.id` must match), so a status written by anyone else
  can't make a commit live.
- **Hosting:** a small webhook service (`app/`, Railway project `commit-live-app`).
- **Action:** go-live with `app-id: 5337969` trusts only the App's check run, not commit statuses.
- **Steps for Joshua:** generate a private key and a webhook secret in the App settings, put both on the host, set
  the webhook URL, and install the App on a test repo.
