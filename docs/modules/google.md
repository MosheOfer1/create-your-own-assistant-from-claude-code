# Google (Gmail, Calendar, Drive)

## What it does

The assistant reads and changes your Gmail, Google Calendar and Google Drive through the
claude.ai connectors of the Claude account it is logged in with. No Google password or token
is kept on the machine.

## Turn it on

1. At claude.ai → Settings → Connectors, connect Gmail, Google Calendar and Google Drive.
2. Run the gateway as its own user (`bin/own-user.js`, Linux).
3. In `config.json`: `"modules": { "google": {} }`.

## What runs freely, what asks

- Free: reading mail, events and files. This taints the conversation (others wrote that text).
- Free in a clean conversation: drafts, labels, spam marks, your own new or copied files,
  an event with no guests and no updates sent.
- Always asks: sending, replying, forwarding, sending a draft, sharing a file, deleting an event,
  answering an invite. An event with guests asks (it invites people).
- Everything else (trash, delete a label ...) asks.

## Limits and known issues

- Only as its own user. `claude -p` loads connectors only with the user's own settings and
  without `--strict-mcp-config`. As your own user that would load your `~/.claude` again.
- The gateway checks that the assistant's `~/.claude` stays clean (no CLAUDE.md, skills, hooks,
  plugins, allow rules). If not, it turns the connectors off and says why in the log.
- The connectors' tool names come from claude.ai. If they change, update `modules/google/index.js`.
