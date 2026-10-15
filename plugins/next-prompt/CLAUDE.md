# next-prompt

Guidance specific to this mod. Repo-wide mod guidance (layout, commands, architecture, test kit) is in the root `CLAUDE.md`.

## What it is

Improves Claude Code's dim next-prompt suggestion (the `prompt.suggest` event). Built 2026-10-15; the user asked for all four of: smarter guesses, several choices, clean-up, learning habits.

- `prompt.suggest` with `e.origin.kind === 'suggestion'` (the engine's own guess after a turn) is the trigger. Another plugin's `$.prompt.suggest` passes through untouched. The mod therefore does nothing while the engine's prompt suggestions are off.
- The hook awaits `$.model.fork` with the prompt from `request()` in `hooks/suggest.ts`: the tail of the last main-loop answer (`lastAnswer`, kept at `turn.complete`, since a fork replays the last *request* and so lacks the final answer), the person's recent prompts, frequent short prompts, guesses they kept passing over, and the engine's own guess. The reply is parsed one candidate per line, run through `filter()`, and the engine's guess is appended last. Up to 4 are kept in `candidates`; the first replaces the shown text. Nothing left: `{ isShown: false }`.
- `prompt.submit` records each sent prompt in `$.store` `history` (`Sent`, capped at 300) with the guesses on offer and which one was taken (`match()`: exact, or edited by prefix). Meta prompts and slash commands are skipped, so `/next 2` still sees the guesses. It has a `.catch` that passes the prompt on: recording must never block a prompt.
- The guesses show in two places (the user chose these two on 2026-10-15 from four tried; a typeahead via `prompt.autocomplete` and a `/next` sidebar pane were built and removed):
  - **Chips:** an `AbovePrompt` hook that calls `next(e)` first and adds a row of plain Buttons (keys `chip-<i>`, hotkeys 1-4, `$.prompt.fill`) beneath whatever the band below drew (step-tracker's tree), or alone when the engine's own (`type: 'engine'`) came back. If step-tracker runs above this mod in the chain it draws without calling `next`, and the chips do not show.
  - **Hint line:** a `PromptHint` hook setting `tail` to guesses 2-4 while the box is empty and idle.
  - `ui` (state, mirrored from `$.store` `ui` at `session.start`) holds which are on; `/next ui chips|hint|all|none` sets it. `/next` lists the guesses as text and `/next <n>` fills the box. `/next off` sets `$.store` `isEnabled` false: no fork, the engine's guess still filtered.
- Pure logic lives in `hooks/suggest.ts` and is tested directly; the hooks are tested against the engine with `model.fork`, `store.*`, `session.cwd` and `prompt.suggest`/`prompt.fill` answered by the test (`world()` in `tests/next-prompt.test.ts`). The test's `$.prompt.suggest({ text, origin: { kind: 'suggestion' } } as never)` stands in for the engine's guess.

## Open questions

- Whether `prompt.suggest` fires after `turn.complete`. If it fires first, `lastAnswer` is the previous turn's; the fork and the engine's guess still carry the latest context.
- The hook makes the shown suggestion wait for the fork. Fine so far in tests; watch the real latency.
- The chain order of this mod and step-tracker on `AbovePrompt`, which decides whether the chips show while step-tracker has a job on screen.
