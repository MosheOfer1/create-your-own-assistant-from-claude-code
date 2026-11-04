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
