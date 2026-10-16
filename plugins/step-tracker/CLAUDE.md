# step-tracker

Guidance specific to this mod. Repo-wide mod guidance (layout, commands, architecture, test kit) is in the root `CLAUDE.md`.

## What it is

A live `Steps` panel in the band above the prompt (`AbovePrompt`; `/steps pane` draws the same tree in a `Pane`) plus a status-line summary showing the steps Claude is working through, which one is active, and what tool or subagent is running now. The mod registers its own tools `mcp__step-tracker__plan` and `mcp__step-tracker__step` (a build may not offer `TaskCreate`/`TodoWrite` at all; this one did not), and three triggers ask Claude to record multi-step work with them: a `prompt.compose` hook appends a system-prompt section; a `prompt.submit` hook attaches a `context` block beside every prompt (read by the model, never shown); and the generic `tool.call` hook adds a `context` reminder after the result of a job's second main-loop tool call when no plan is recorded (once per job, never for a subagent). Added 2026-10-12 because the system-prompt section alone was often ignored under a long CLAUDE.md. Calls to the built-in `TaskCreate`/`TaskUpdate`/`TodoWrite`, when they exist, are mirrored into the same list. Commands: `/steps`, `/steps history`, `/steps hide`, `/steps pane`, `/steps reset`. Every prompt is a new job (user's choice): `turn.start` archives the previous job's steps into `history` (capped at 30, session state), records the new `job` with an excerpt of the prompt, and empties the list; the band header shows an excerpt of the job's prompt with a plain `[more]`/`[less]` Button (key `prompt`, drawn only when the excerpt differs from the full prompt or the estimated row width exceeds `e.props.bodyColumns`) that toggles `isPromptExpanded` to show `job.fullPrompt` (capped at 2000 chars) wrapped beneath the header; the flag resets on every new job. The header's right side holds `◀ pos/total ▶` Buttons (keys `older`/`newer`) that page `viewIndex` through `history` (`pageHistory`); `viewIndex` resets to null on every new job. The header is always the live job (user's choice: a new prompt moves the band to the current job at once) and a new job starts with an empty list ("No steps recorded for this job yet."); earlier jobs are reached with the arrows alone. (A dimmed `last job:` retention of the previous list under an empty job existed 2026-10-13 to 2026-10-14 and was removed at the user's request: it read as stale steps.)

## Your turn

Added 2026-10-16: the user could not tell from the frame that Claude had stopped and a step needed them (an open `in_progress` step looked as if it was still running). `phase` gains `yours` (set at the main loop's `turn.complete`, with `endReason` from `e.reason`; `turn.start` clears both) and `waiting` (while a main-loop `AskUserQuestion`/`ExitPlanMode` call runs, `ASK_TOOLS`). `idle` now means only "no turn yet". While `isPersonsMove`: frame `warning` (`success` when `yours` with no open step), header `· your turn`, the `in_progress` step drawn `⏸` with `waiting for you` instead of its activeForm, and the Now line from `yourTurnText()`. A turn with no steps and no history still draws no band. Permission dialogs are not detected: `tool.check`'s `ask` cannot tell a dialog from the auto-mode classifier.

## Tests

`tests/tracker.test.ts` holds the `world()` helper and `callAny` referred to in the root `CLAUDE.md`'s test-kit notes.

## Installed for every session

Since 2026-10-07 the mod is installed at user scope as `step-tracker@gene-claude-mods`. Since 2026-10-15 it lives in `plugins/step-tracker/` (it was the repo root before) and installs from the GitHub marketplace, not this checkout; the release steps are in the root `CLAUDE.md` under "Installed for every session".

## Hot reload

`C:\Users\gene\.claude\dev-mods\<session-id>\step-tracker` is a Windows junction to this folder (`plugins/step-tracker`, not the repo root) when a session has hot reload enabled; the engine then writes `.claude-plugin/types/` here (gitignored) and reloads on every save. Outside such a session, `claude --plugin-dir plugins/step-tracker` does the same.
