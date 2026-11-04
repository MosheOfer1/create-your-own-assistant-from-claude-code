# Setup tools

Files: `gateway/bin/setup.js`, `service.js`, `remote.js`, `chrome-step.js`. The
`create-assistant` skill calls them step by step. You can also run them yourself.
Each command prints `--help`. Each step is safe to run again.

## setup.js

State and settings, all under `~/.assistant` (or `ASSISTANT_HOME`):

- `status`, `mark STEP done|skipped`, `log TEXT`. Steps: language, plan, prereqs, host, code, repo,
  claude, whatsapp, telegram, email, voice, logins, service, deploy, test.
- `get [KEY]`, `set KEY JSON`: read and change `config.json`. Dots mean nesting
  (`modules.email.user`). Secrets are refused here.
- `repo create NAME`, `repo push`: a private GitHub repo (needs `gh`) with `config.json` and `brain/`.
  It is cloned to `~/.assistant/repo`.
- `secret NAME --url URL --say TEXT`: you paste a secret in a local window. It goes to
  `data/.env` (mode 0600). Names: `EMAIL_APP_PASSWORD`, `TELEGRAM_BOT_TOKEN`, `TRANSCRIBE_API_KEY`,
  `ANTHROPIC_API_KEY`. `has NAME` answers yes or no, never the value.
- `whatsapp`: prints a pairing code and waits up to 10 minutes. `check`: shows what the machine has.

## service.js

Runs the gateway as a service. Linux: a systemd user unit with `MemoryMax` (default `2G`,
`--memory` changes it) and linger. macOS: a launchd agent. Commands: `install`, `uninstall`,
`status`, `restart`, `logs [N]`, `update`.

`update` runs every 5 minutes from a timer. It pulls the private repo. A new `config.json` restarts
the gateway. If `version` in `config.json` names another git tag, it checks out that tag, runs
`npm ci` and restarts. So a push to the private repo is live in about 5 minutes.

## remote.js

Puts the assistant on a Linux machine over SSH, with your own key. It does not use sudo.
Commands: `check USER@HOST` (needs 2 GB RAM, systemd user session, git), `install` (Node into
`~/.local/opt`, the repo, Chromium, a deploy key for the private repo, config and secrets over ssh
stdin, the service), `login` (prints the one command to log in Claude there), `logs`.
Options: `--key FILE`, `--version TAG`, `--repo OWNER/NAME`.

## chrome-step.js

A visible Chrome window with a bar and a Done button. Commands: `login` (you log in; cookies are
saved), `step` (any step by hand), `secret` (a hidden field), `push` (send saved logins to the
machine over ssh, then delete the local copy). Nothing you type goes through the chat.

## Secrets

All four names above. They live in `data/.env` only.

## Limits and known issues

- The machine must stay on and awake. Linux without linger stops at logout. The tool says what to ask the admin.
- On Ubuntu with restricted user namespaces, Chromium may need `--no-sandbox`.
- Only systemd (Linux) and launchd (macOS) are supported. On Windows, use WSL2 with systemd.
- Not yet tried on clean machines. See [live checks](../live-checks.md).
