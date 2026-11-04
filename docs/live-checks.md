# Live checks still to run

Code that is unit-tested with fakes but not yet tried against the real service.
Each line: what to check, and what it needs.

| Stage | Check | Needs |
|---|---|---|
| 2 | WhatsApp pairing code links the assistant's number (default Baileys browser) | A second SIM/eSIM with WhatsApp |
| 2 | Owner writes "hi" → 👀 → reply; a third person writes → nothing | Same, plus the owner's phone |
| 2 | Owner via LID chat is recognised; reply goes back to the same chat | Same |
| 2 | Logout (remove the linked device) → alert on Telegram | Same, plus a Telegram bot |
| 2 | Telegram: "/start <code>" pairs; reactions and typing work | A Telegram bot token from @BotFather |
| 3 | Email: search, read, draft in a real Gmail; send asks, then goes; hourly triage alerts once | A test Gmail with an app password |
| 3 | Voice note → whisper.cpp transcript → turn | whisper.cpp + a model on the host (setup installs them) |
| 3 | Brain in an existing Obsidian vault with git: commits after changes, push when asked | A test vault repo |
| 5 | chrome-step login in a visible window on a desktop (Google), Done → the gateway's browser is logged in | A test Google account |
| 5 | chrome-step push to an existing machine over ssh | The test machine (stage 10) |
| 6 | setup.js whatsapp shows a pairing code and links | The second SIM/eSIM |
| 6 | The whole create-assistant skill, start to "hi", in another language than English | A clean user / machine (stage 10) |
| 6 | setup.js repo create (gh) → private repo with config.json + brain/ | A test GitHub account |
| 7 | service.js install on Linux (systemd + linger) and macOS (launchd); survives reboot | A Linux user and a Mac |
| 7 | remote.js check / install on a clean machine over ssh (Node to ~/.local/opt, deploy key) | A clean LXD container |
| 8 | A push to the private repo is in effect from the next message (config change restarts; version change updates code) | Same |
| 8 | own-user.js install on a clean Ubuntu 24.04 (user, /opt code, unit, deploy key, check all ok), then a version bump updates through the path unit | A clean LXD container + sudo |
