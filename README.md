# Create your own assistant from Claude Code

Your own personal assistant, built by Claude Code, on your own machine.
It has its own WhatsApp number, reads your email, keeps reminders,
browses for you and keeps a second brain in Markdown.

> Work in progress. Not ready for use yet.

## Install (when ready)

```
/plugin marketplace add OWNER/create-your-own-assistant-from-claude-code
/plugin install assistant@create-your-own-assistant
```

Then tell Claude: "create my personal assistant".

## Layout

| Path | What |
|---|---|
| `plugin/` | Claude Code plugin: skills for setup and browsing |
| `gateway/` | The assistant service (Node 22) |
| `scripts/` | Repo tools (personal-data scanner) |

## Contributing

```
git config core.hooksPath .githooks
```

The hooks run `scripts/scrub-scan.mjs` on each commit.
Put your own private patterns in `~/.config/scrub-patterns.txt`
(outside the repo, one per line). CI runs gitleaks on every push.

## License

MIT
