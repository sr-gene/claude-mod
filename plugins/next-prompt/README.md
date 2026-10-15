# next-prompt

A Claude Code mod that improves the dim "next prompt" suggestion Claude Code shows in the empty prompt box after each answer (Tab or → takes it).

- **Smarter guesses.** When Claude Code makes its guess, the mod asks the model again over the same conversation, with the end of the last answer, your recent prompts and what you tend to type. The best guess replaces the dim suggestion.
- **Several choices.** Up to four guesses are kept, best first; Claude Code's own guess stays in the list. They show in two places besides the dim text in the box:
  - **Chips:** a `Next  1: push it  2: run the tests …` row at the bottom of the band above the prompt. Click one (fullscreen), or ctrl+x tab then its digit, to put it in the box.
  - **Hint line:** the other guesses at the end of the dim line under the prompt, `next 2: … · 3: … (/next <n>)`.

  `/next` lists them and `/next 2` puts guess 2 in the box. `/next ui` turns either place on or off.
- **Cleaned up.** Fillers ("continue", "ok", "thanks"), a repeat of the prompt you just sent, duplicates, multi-line or over-long guesses, and guesses you keep passing over are dropped. If nothing is left, nothing is shown.
- **Learns your habits.** Every prompt you send is recorded (across sessions, per project first): what you typed and which guess, if any, you took. That shapes the next guesses. `/next stats` shows how often guesses were taken.

Claude Code's own prompt suggestions must be on: the mod works on the guess Claude Code makes after each turn.

## Commands

- `/next` lists the guesses.
- `/next ui [chips|hint|all|none]` shows or picks where the guesses show (both by default).
- `/next <n>` puts guess *n* in the prompt box.
- `/next stats` shows how often the guesses were taken.
- `/next off` stops the extra model call (Claude Code's guess is still cleaned up); `/next on` starts it again.
- `/next forget` clears every recorded prompt.

## Cost

Each guess is one extra, tool-less model call over the session's own conversation, which the prompt cache mostly serves. `/next off` turns it off.

## Install

```
/plugin install next-prompt --marketplace sr-gene/gene-claude-mods
```

## Develop

From the repository root:

```
claude plugin validate plugins/next-prompt
claude plugin test plugins/next-prompt
```
