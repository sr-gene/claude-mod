# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

The **step-tracker** mod: a live `Steps` panel in the band above the prompt (`AbovePrompt`; `/steps pane` draws the same tree in a `Pane`) plus a status-line summary showing the steps Claude is working through, which one is active, and what tool or subagent is running now. The mod registers its own tools `mcp__step-tracker__plan` and `mcp__step-tracker__step` (a build may not offer `TaskCreate`/`TodoWrite` at all; this one did not), and a `prompt.compose` hook appends a system-prompt section asking Claude to record multi-step work with them. Calls to the built-in `TaskCreate`/`TaskUpdate`/`TodoWrite`, when they exist, are mirrored into the same list. Commands: `/steps`, `/steps history`, `/steps hide`, `/steps pane`, `/steps reset`. Every prompt is a new job (user's choice): `turn.start` archives the previous job's steps into `history` (capped at 30, session state), records the new `job` with an excerpt of the prompt, and empties the list; the band header shows the job's prompt. While the current job has no steps, the band draws the last history job dimmed under a `Last job` header with the current prompt beneath it (user's choice, so a finished list never disappears on a question); the first plan of the new job replaces it.

It is a Claude Code **mod**: a plugin of *function hooks* that runs inside Claude Code itself (terminal, desktop Code tab, VS Code, mobile) and can draw panes/bands/status text, intercept tool calls and prompts, register slash commands and tools, run timers, etc. It is **not** a classic settings-hook plugin (`claude plugin init` scaffolds that other kind under `~/.claude/skills`; do not use it here).

The repo root is the mod folder and doubles as its own marketplace, so the shape is:

```
.claude-plugin/plugin.json       { name, version, description, "types": "./types/index.d.ts" }
.claude-plugin/marketplace.json  { name, owner: { name }, plugins: [{ name, source: "./" }] }
.claude-plugin/types/            WRITTEN BY THE ENGINE on every load. Never edit, never commit by hand.
hooks/hooks.json                 { "modules": ["./register.tsx"] }   (exactly one module path, relative to this file)
hooks/register.tsx               export const register: Register = (on, options) => { ... }
types/index.d.ts                 the mod's state/noun contract (declare module 'claude-code' { interface PluginState { ... } })
tests/*.test.ts(x)               run by `claude plugin test`
tsconfig.json                    extends ./.claude-plugin/types/tsconfig.json (engine-provided)
```

**Before writing or debugging `hooks/`, load the `plugin-authoring` skill** (`/plugin-authoring` or the Skill tool). It writes this build's full API declaration (`claude-code.d.ts`, ~21k lines) and holds the three worked examples (pane, band, tool-call guard). The declaration file is the authority on every event's input/result, every `$` noun, and every element's props. The API is early access and changes between releases: grep the `.d.ts` for the name at hand (`'tool.call'`, `Pane: {`, `export type ToolCallResult`) rather than trusting memory.

## Commands

```sh
claude plugin validate .        # reads manifest + module source the way the engine will; lists hooks, calls, and everything it would refuse. Run early and often.
claude plugin validate . --strict --json   # CI form: warnings fail, machine-readable report
claude plugin test .            # runs every *.test.ts(x) under the dir against the real engine host (no fs/network/process). No name/file filter exists: to run one file, pass its parent folder (e.g. `claude plugin test tests/pane`).
tsc -p .                        # type-check. Only works after the engine has laid .claude-plugin/types/ (i.e. after the mod has loaded once).
claude --plugin-dir . --debug   # run a session with this mod loaded from disk; the folder is watched and saves hot-reload the module.
```

Inside a running session: `/reload-plugins` re-reads an installed/marketplace plugin. A mod being edited by the model inside its own session reloads once when the turn ends.

Installing for someone else (also the line a README's install section should carry):

```
/plugin install <name-from-plugin.json> --marketplace <owner>/<repo>
```

Live hot-reload during a Claude Code session uses the session's dev-mods folder (`~/.claude/dev-mods/<session-id>/<mod-name>/`); the skill explains the "Enable hot reloading" prompt. Work there is copied back into this repo, which is the kept copy.

## Architecture: how a mod executes

- **One module, one `register`.** `on(event, matcher?, hook)` adds hooks. Every hook is `($, e, next)`: `$` is the engine interface (all of `$.ui`, `$.state`, `$.store`, `$.clock`, `$.fs`, `$.process`, `$.model`, `$.tool`, `$.agent`, `$.command`, `$.prompt`, `$.session`...), `e` is the frozen event input, `next(e)` runs the chain beneath and resolves the event's result. Return without `next` to answer alone; `next({ ...e, x })` rewrites what the rest sees.
- **Sandboxed runtime.** No DOM, no Node, no `require`, no dynamic `import()` (a module containing one does not load). ES modules only; files must be `.ts/.tsx/.js/.jsx/.mjs/.cjs/.mts/.cts`. Everything outside is reached through `$`. JSX compiles against global `h`/`Fragment`.
- **Elements come from the surface, not globals.** `const { Box, Text, Button } = $.ui.resolve(e)` inside a `ui.render` hook. Tables differ per `e.surface` (`terminal`, `desktop`, `vscode`, `mobile`): e.g. `mobile` has no `Input`/`Select`; `terminal` alone has `Raster`/`Image`, no `Svg`. A tree that does not validate is silently replaced by the engine's own drawing; the reason is in `claude --debug` output (`ui.render (<Component>): a hook returned a tree that does not validate`).
- **State lives in `$.state`, not module variables.** A reload (every save) re-runs `register` in a fresh environment; module-level `let`s reset, `$.state` (session) and `$.store` (cross-session) survive. Use `atom(ref, initial)` / `read($, atom)` / `update($, atom, fn)` from `'claude-code'`. Reading in a render hook subscribes it; writing redraws readers automatically (no `$.ui.invalidate` needed). **A render hook must never write state.** Every `$.state` key must be declared in `types/index.d.ts`; `claude plugin validate` enforces this.
- **Guards need `.catch`.** A hook that can refuse (`tool.call`, `tool.check`, `prompt.submit`, `config.set`, ...) is skipped if it throws, meaning the thing it was guarding proceeds. Write `on(...).catch(($, e, next) => next.called ? next(e) : { deny: 'why' })`. Judge *before* calling `next`.
- **Long-lived work starts in `session.start`.** Each hook runs inside one dispatch with a time budget; `next.signal` aborts when abandoned. Timers (`$.clock.every/after`), command registration (`$.command.register`), tool registration (`$.tool.register`), and unasked pane opens belong in `session.start`, which is awaited before the first prompt. Reloads fire `session.start` again.
- **Panes vs bands.** `$.ui.open({ id, title })` + `ui.render` on `{ component: 'Pane', requestId: id }`. Opened by a user action it seats at any width; opened unasked it only docks from 144 columns (`e.viewport.isFullscreen`). `AbovePrompt` band: return a tree or `next(e)` for nothing. Size trees to `e.props.bodyColumns`, not `e.viewport.columns`.
- **Streaming events** (`turn.step`, `process.spawn`) take an `async function*` hook; `yield* next(e)` forwards.
- **Slash commands**: `$.command.register` in `session.start`, answered by `on('command.run', { command }, ...)` returning `{ text }`.
- **Model-callable tools** register as `mcp__<plugin>__<name>` and are served by hooking `tool.call` with that matcher.

## Tests

Import `test`, `expect`, `mock` from `'claude-code/testing'`. A test body gets the engine's own `$` and an `on` whose hooks sit *beneath* the plugin, standing in for the engine. UI tests mount through `$.ui.mount({ plugin, surface, component, props })` and act by key (`press`, `input`, `find`); loop the body over `['terminal', 'desktop'] as const` so the test proves surface independence. Options come from `test(name, { options }, body)`.

Facts about the kit that are not obvious from the docs (see `world()` in `tests/tracker.test.ts`):
- The test's `$` has only the nouns `tool, command, config, prompt, skill, attribution, agent, session, telemetry, turn, ui` plus `classic`. There is **no `$.state`**: read plugin state back by hooking `on('state.set', ($, e, next) => { record(e.key, e.value); return next(e) })`.
- Nothing answers `$.clock`, `$.ui.status`, `$.store` or `$.env` beneath the plugin, and a hook that calls one with no implementation is **skipped**. Every test therefore calls `mock.clock(on)` and registers `on('ui.status', () => ({ value: undefined }))` first (a hook answering a call on `$` returns `{ value }`).
- A `ui.render` hook that passes with `next(e)` needs the engine's drawing beneath it in a test: `on('ui.render', () => ({ type: 'engine', ref: 0 }))`.
- `$.tool.call({ tool, ...args })` runs the plugin's `tool.call` chain; the test's own `on('tool.call', { tool }, () => ({ result }))` is the tool. `$.turn.start(...)` and `$.turn.complete(...)` raise those events the same way.
- `On` is exported from `'claude-code'`, not from the testing module. `Mounted<Surface, Component>` from the testing module types a mounted pane handle.
- Once the engine has laid `.claude-plugin/types/`, a matcher's `tool` and `$.tool.call`'s input are this build's **closed union** of tool names. The mod's own registered tools are not in it either (the union is laid before `session.start` registers them), so their `tool.call` hooks match by RegExp and cast `e as unknown as Record<string, unknown>`. A registered tool's `result` must be a **string or an array**; the engine refuses an object. A tool that exists in no build (a test stand-in) is matched with a RegExp and called via `$.tool.call(input as never)`; see `callAny` in the tests.

## Type-checking before the engine has laid types

`tsc -p .` only works after a load has written `.claude-plugin/types/`. Before that, a scratch tsconfig outside the repo (the one in the types file header) whose `include` names the skill's `types/claude-code.d.ts` plus this repo's `hooks`, `types` and `tests` folders does the same job: `npx -p typescript@5 tsc -p <scratch dir>`.

## Installed for every session

Since 2026-10-07 the mod is installed at user scope as `step-tracker@gene-claude-mods`, from this folder registered as a marketplace (`claude plugin list` shows `Read from: D:\gene\projects\gene\claude-mod`). Every session loads it from here directly, no copy: after an edit, `/reload-plugins` in a running session picks it up. `claude plugin validate .` and `claude plugin test .` still apply before reloading.

## Hot reload in this repo

`C:\Users\gene\.claude\dev-mods\<session-id>\step-tracker` is a Windows junction to this folder when a session has hot reload enabled; the engine then writes `.claude-plugin/types/` here (gitignored) and reloads on every save. Outside such a session, `claude --plugin-dir .` does the same.
