# Gateway

The assistant service. Node 22, no dependencies in the core.

```
channel (WhatsApp, Telegram, terminal) ──▶ router ──▶ agent: claude -p (one warm process)
                                              │            │ tool not pre-allowed
                                              │            ▼
                                              │      mcp/approve.js ──▶ control API (127.0.0.1, token)
                                              │                              │
                                              ◀── policy: free? ── no ──▶ ask the owner: "yes / no"
```

| File | What |
|---|---|
| `src/router.js` | Owner messages in, one turn at a time, 👀, stop, new chat, approvals, resume after restart |
| `src/agent.js` | Runs `claude -p`: a warm process for the chat, one-offs for checks; filtered environment |
| `src/policy.js` | Free inside, gated outside: what runs without asking; tainted conversations |
| `src/commands.js` | Allow list of read-only shell commands |
| `src/approvals.js` | Open requests, parked requests, late answers; kept on disk |
| `src/gateway.js` | Wires it together; loads modules |
| `src/i18n.js` | The gateway's few fixed lines, per language |
| `mcp/stdio.js` | A minimal MCP server (no SDK) for the approval tool and modules |

## Try it

```
npm test
npm run cli -- --echo     # no claude, replies echo
npm run cli               # the real agent in your terminal
```

Settings: `~/.assistant/config.json` (or `ASSISTANT_CONFIG`). Defaults in `src/config.js`.

## Rules

- Messages to other people, payments and bookings always ask (`GATED` in `src/policy.js`).
- The agent never gets the gateway's secrets (`agentEnv`).
- After it reads outside text (a page, an email, a forwarded message) the conversation is
  tainted: strong actions ask until a new conversation.
- A module adds tools, rules and routes (see the comment at the top of `src/gateway.js`).
