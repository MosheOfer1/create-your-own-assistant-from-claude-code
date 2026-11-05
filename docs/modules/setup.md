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

There is no timer. The gateway pulls the private repo itself (`src/sync.js`): before it answers a
message (at most once a minute) and once a day. A new `config.json` restarts the gateway, and it then
answers the same message. If `version` in `config.json` names another tag, it checks it out, runs
`npm ci` and restarts. So a change pushed from outside (GitHub, Obsidian on a phone) is in effect from
the next message. Reminders and everything asked in the chat never wait for this.
`update` does the same pull now, by hand.

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

## Own user (`own-user.js`, Linux and WSL2)

Run once with sudo: `sudo "$(command -v node)" ~/.assistant/app/gateway/bin/own-user.js install`.

- A system user `assistant`: no password, no login shell, no sudo, no admin group.
- The code goes to `/opt/assistant/app`, owned by root. The assistant can read it, never change it.
- Its config, private repo, data and folder are a copy of yours in `/home/assistant/.assistant`.
  Your own `~/.assistant` stays as a backup. Your user service stops (one gateway at a time).
- `assistant.service` hides all other homes (`ProtectHome=tmpfs`), keeps the system read-only
  (`ProtectSystem=strict`), and caps memory. Shell commands that change things still ask
  (`freeShell` stays off): the agent runs as the same user as the gateway and could read its secrets.
- Its clone of the private repo gets its own deploy key. Your GitHub login stays yours.
- Claude: it logs in once on its own (`check` prints the command:
  `sudo -u assistant -H /home/assistant/.local/bin/claude /login`). A copy of your login would share one
  refresh token with yours: when either side refreshes, the other one stops working.
- A new `version`: the assistant writes `data/update-request.json`; `assistant-update.path` (root)
  checks out that tag, runs `npm ci` and restarts it. The assistant never runs sudo.
- New secrets or logins later: `sudo … own-user.js sync-from-owner`. Safety check: `check`.
  Back to your own user service: `uninstall` (the user and its data stay).
- macOS: not supported; the assistant runs as your user with the guards in the code.
