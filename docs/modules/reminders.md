# Reminders

Folder: `gateway/modules/reminders/`. It keeps reminders and timed tasks. Jobs are saved in
`<dataDir>/jobs.json`, so they survive a restart.

## What it does

- `remind`: at the set time, the text is sent to you. Nothing else happens.
- `task`: at the set time, the assistant runs your instruction as a new turn and reports the result.
- `list` shows open jobs with their ids. `cancel` removes one by id.
- A check runs every 30 seconds. A job moves to its next time before it runs, so it never runs twice.

## Config keys (`modules.reminders`)

```json
"modules": { "reminders": { "workDays": [0, 1, 2, 3, 4] } }
```

- `workDays`: the days that "workdays" means. Sunday is 0. Default `[1, 2, 3, 4, 5]`.
- The time zone is the top-level `timezone`.

## Tool input

- `when`: local time as `"YYYY-MM-DD HH:MM"`, or `in_minutes`.
- `repeat`: `none` (default), `daily`, `workdays` or `weekly` (the weekday of `when`).

Example: "Remind me every workday at 9 to take the pills". The agent sets `repeat: workdays`.

## Secrets

None.

## What runs freely, what asks

- Free: `remind`, `list`, `cancel`. A reminder only writes to you.
- Asks: `task`. You see the text of the task and the time. You approve it once, when it is set.

## Limits and known issues

- Times in the past (more than 1 minute) are refused.
- If the gateway is down at the set time, the job runs when it starts again.
- Repeat options are fixed. There is no monthly repeat.
- A task runs as a normal turn in the current conversation. If that conversation is tainted,
  the strong actions of the task ask, as always.
