# Brain

Folder: `gateway/modules/brain/`. The second brain is a folder of Markdown files. An Obsidian
vault works. The files are the truth. A SQLite index (`<dataDir>/brain.sqlite`) is only a cache.

## What it does

- Learning: after `learnIdleMin` minutes (15) without a message, a small model with no tools reads
  your own messages since the last time and proposes lasting facts. Code keeps only known types,
  short ones, no secrets, nothing already known; a rule only with your exact words. Forwarded text,
  pages, mails and the assistant's own replies are never read for this. `learnIdleMin: 0` turns it off.

- Chat commands, with no turn: `memory` / `זיכרון` lists the saved facts (`(?)` = not in your own words),
  `forget 3` / `תשכח 3` removes one.

- Keeps facts in `memory/facts.md`, one per line. The details are in a comment that Obsidian hides:
  `- Dana is vegetarian <!-- id:3 type:preference scope:food source:owner date:2026-11-04 -->`
- Fact types: `fact`, `preference`, `rule`, `person`, `project`.
- Keeps free notes in other files (`note` tool, with `append`).
- Before each turn it adds matching facts and notes to the prompt (recall).
- Your own rules and preferences are always in the system prompt (core).
- Search uses SQLite FTS5. It also matches Hebrew words with a one-letter prefix.
- Rebuilds the index at start.

## Config keys (`modules.brain`)

- `dir`: the Markdown folder. Default `<agentCwd>/brain`. Point it at your vault if you have one.
  The setup tool sets it to `brain/` in your private repo.
- `commit`: changes are committed after 30 quiet seconds if the folder is a git repo. Default on.
  Set `false` to stop it.
- `push`: also push after the commit. The setup tool turns it on for the private repo.
- `recallChars` (1500), `coreChars` (1500): the size of the recall and core text.

## Tools

`search`, `remember`, `forget`, `note`.

## Secrets

None. Git push uses the machine's git login or deploy key.

## What runs freely, what asks

All four tools run freely. Writing the brain reaches nobody.

## Limits and known issues

- A `rule` needs a `quote`: your exact words from the last messages. The code checks the quote.
  Without it the fact is saved as `source:agent` and is never a rule. Forwarded and quoted text does not count.
- Commits happen only if `dir`, or its parent folder, has a `.git` folder. A home folder that is a
  git repo gets no commits.
- If git add or push fails, the module logs it and goes on.
- Brain text comes back to the agent in later turns. Do not store text from untrusted pages as rules.
