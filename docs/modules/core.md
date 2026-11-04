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

## Secrets

The gateway reads `<dataDir>/.env` (file mode 0600). The agent gets a filtered environment: `PATH`,
`HOME`, `ANTHROPIC_*`, `CLAUDE_*` and a few more. It never gets `TELEGRAM_BOT_TOKEN`,
`EMAIL_APP_PASSWORD` or `TRANSCRIBE_API_KEY`. `Read` is denied for `dataDir`, `~/.ssh`, `~/.claude`,
`~/.config` and `~/.gnupg`.

## What runs freely, what asks

- Free: `Read`, `Glob`, `Grep`, `WebSearch`, `TodoWrite`. Read-only shell commands from an allow list.
  Writes to files in the agent's own folder (not dot paths, not `data/`, not the gateway code).
- Always asks: any tool whose name matches send, reply, forward, share, pay, buy, book, order,
  or respond_to_event.
- Everything else asks, unless a module allows it.
- Tainted conversation: `WebFetch` only for plain addresses (no query), and free shell stops.
- A request waits `approvalTimeoutMin`. Then it is parked. A late "yes" counts for `approvalHoldHours`.

## Limits and known issues

- `freeShell: true` lets plain shell commands run without asking. Use it only when the gateway
  runs as its own user.
- `lockHost: true` is for shared machines. It blocks system folders and other folders for file tools.
- After a restart, a turn cut off less than 15 minutes ago runs again once.
- `WebFetch` is Claude's own tool. It is denied this machine and cloud metadata by name (`LOCAL_FETCH_DENY`); the browse module checks every address after DNS.
