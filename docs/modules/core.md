# Core

The core is in `gateway/src/`. It has no dependencies. It connects a channel (WhatsApp, Telegram,
terminal) to the agent (`claude -p`) and decides what the agent may do alone.

## What it does

- `router.js` takes the owner's messages one at a time. It reacts with 👀 when a message arrives.
  Messages that come close together (`batchMs`) become one turn.
- `agent.js` runs `claude -p`. One warm process serves the chat. One-off processes serve checks.
- `policy.js` decides: free, or ask. `approvals.js` keeps the open requests on disk.
- `gateway.js` loads the modules. Each module adds tools, rules and routes.
- A local control API (127.0.0.1, with a token) connects the agent's approval tool to the router.

## Chat commands

`stop` (ends the turn), `/new` (new conversation), `/status`, `yes` / `no` (also `yes 3`).
Yes and no words exist in several languages.

## Config keys (`config.json`)

`language`, `ownerName`, `timezone`, `dataDir`, `agentCwd`, `claudeBin`, `model`, `tools`, `warm`,
`warmIdleMin`, `batchMs`, `sessionIdleHours`, `contextMaxK`, `approvalTimeoutMin`,
`approvalHoldHours`, `freeShell`, `lockHost`, `channels`, `modules`, `version`.
Defaults are in `gateway/src/config.js`. `ASSISTANT_HOME` and `ASSISTANT_CONFIG` change the paths.
A module is off when `modules.<name>.enabled` is `false`.

## Your own modules

Keep what is personal out of the public code: put a module in your private repo, in
`modules/<name>/index.js`, and turn it on in `config.json` (`"modules": { "<name>": {} }`).
- It has the same contract as a built-in module (top of `gateway/src/gateway.js`).
- A built-in module with the same name wins. Names use `a-z`, `0-9` and `-`.
- It reaches the core by absolute path: `await import(\`${config.root}/src/net.js\`)`.
- A change in `modules/` restarts the gateway after the next pull, like a change in `config.json`.
- It runs with the gateway's rights. Only code you wrote or checked belongs there.

## Secrets

The gateway reads `<dataDir>/.env` (file mode 0600). The agent gets a filtered environment: `PATH`,
`HOME`, `ANTHROPIC_*`, `CLAUDE_*` and a few more. It never gets `TELEGRAM_BOT_TOKEN`,
`EMAIL_APP_PASSWORD` or `TRANSCRIBE_API_KEY`. `Read` is denied for `dataDir`, `~/.ssh`, `~/.claude`,
`~/.config`, `~/.gnupg`, cloud and package logins (`~/.aws`, `~/.docker`, `~/.npmrc`, `~/.netrc` ...),
browser profiles, shell history, `~/.local/share` and `~/Library` (full list: `secretReadDeny` in `policy.js`).

## What runs freely, what asks

- Free: `Read`, `Glob`, `Grep`, `WebSearch`, `TodoWrite`. Read-only shell commands from an allow list.
  Writes to files in the agent's own folder (not dot paths, not `data/`, not the gateway code).
- Always asks: any tool whose name matches send, reply, forward, share, pay, buy, book, order,
  or respond_to_event.
- Everything else asks, unless a module allows it.
- Read-only network commands (`curl`, `nslookup`, `ping` ...) never reach this machine or the home network.
- Tainted conversation (after a web page, an email, a file in the inbox, or a shell command that
  fetched something): `WebFetch` and `curl` only for plain addresses (no query), `nslookup`/`dig`/`ping`
  ask, memory writes ask, free shell stops.
- An approval shows the whole request. A request too long to show in full is refused, never cut.
- A request waits `approvalTimeoutMin`. Then it is parked. A late "yes" counts for `approvalHoldHours`.

## Limits and known issues

- `freeShell: true` lets plain shell commands run without asking. It is a trusted mode: the agent
  runs as the same user as the gateway, so a free command can read the gateway's secrets
  (`data/.env`, the WhatsApp keys, the control token) and change `config.json`. The list of
  commands that still ask is a deny list and can be bypassed. Turn it on only when you accept that.
- The agent's `claude` loads no settings files (`--setting-sources ""`): not your `~/.claude`
  (its CLAUDE.md, allow rules, hooks, plugins, skills), not a CLAUDE.md in its own folder.
- `lockHost: true` is for shared machines. It blocks system folders and other folders for file tools.
- After a restart, a turn cut off less than 15 minutes ago runs again once.
- `WebFetch` is Claude's own tool. It is denied this machine and cloud metadata by name (`LOCAL_FETCH_DENY`); the browse module checks every address after DNS.
