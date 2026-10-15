# commit-live GitHub App (server)

Webhook server for the App **commit-live light** (App ID 5337969). It writes the App's own `commit-live` check run on
every push / pull_request commit. That check is the trusted light. A **Go live** button appears on lit checks only.
See [SPEC.md](../SPEC.md) section 7.

- `POST /webhook`: GitHub webhooks, verified with `X-Hub-Signature-256`
- `GET /healthz`: `{ ok, configured, appId, missing }`. It stays healthy while not configured, and webhooks get 503.

## Environment

| variable | |
|---|---|
| `GITHUB_APP_ID` | `5337969` |
| `GITHUB_APP_PRIVATE_KEY` | the `.pem` from the App settings: the PEM itself, the PEM with `\n` escapes, or base64 of the PEM |
| `WEBHOOK_SECRET` | the same random string as the App's webhook secret |
| `PORT` | default `3000` |

## App settings

- **Webhook URL:** `https://<host>/webhook`, content type `application/json`
- **Repository permissions:** Checks read & write, Contents read & write (go-live pushes the Pages branch),
  Actions read, Pages read, Metadata read
- **Subscribe to events:** Push, Pull request, Workflow run, Check run

## How a light is set

1. On a push or PR, the server creates the check: `◌ waiting for workflow runs`.
2. On `workflow_run` events it reads every push / pull_request run on that sha (latest attempt). When all are lit, the
   check completes `success` (● lit) with **Go live**. Any dark run makes it `failure` (○ dark). No run means no
   light yet.
3. **Go live** re-reads the check from GitHub and goes ahead only if all of these hold:
   - it is this App's own check;
   - it is completed `success`;
   - it is the newest check on that commit;
   - the person who clicked has write access.

   It then points the Pages root at `c/<sha>/`, the same as the Action's go-live. Previews still come from the Action.

The Action's go-live can trust only this check too: `uses: fitzyracing1/commit-live@v1` with `app-id: 5337969`.

Run locally with `node app/server.mjs`; Docker: `docker build -f app/Dockerfile .`.
