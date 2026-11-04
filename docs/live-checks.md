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
