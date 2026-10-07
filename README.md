# step-tracker

A Claude Code mod that shows, live, the steps Claude is working through, which one is active, and what it is doing right now.

It draws a **Steps** panel directly above the prompt input (collapsible with the `[-]` mark) and a one-line summary on the status line. `/steps pane` shows the same tracker as a pane instead (a sidebar in the fullscreen terminal). The mod registers two tools of its own, `plan` and `step`, and adds one short system-prompt section asking Claude to record multi-step work with them, so it works on every build. When Claude's built-in task tools (`TaskCreate`, `TaskUpdate`, `TodoWrite`) are present and used, those are mirrored into the list as well. Tool calls and running subagents appear under **Now** as they happen. Every prompt is a new job, labelled with its prompt. Until the new job records steps, the panel keeps the previous job's list on screen, dimmed and marked **Last job**, so a finished list never vanishes just because you asked a question. Earlier jobs are kept in a history you can open with `/steps history`.

```
Steps                              1/5 done
  ✓ 1. Read the failing test
  ▶ 2. Fix the guard in parse()
       Editing parser.ts…
  ○ 3. Run the test suite
  ○ 4. Write the summary
  ○ 5. Commit

Now   calling a tool
  ⟳ executor: fixing lint errors
  ▶ Edit src/parser.ts
  · Bash Run the failing test
```

## Commands

- `/steps` shows the panel above the prompt.
- `/steps hide` hides it.
- `/steps history` opens a pane listing previous jobs and their steps.
- `/steps pane` opens the tracker as a pane instead.
- `/steps reset` clears the step list and activity.

## Install

```
/plugin install step-tracker --marketplace sr-gene/claude-mod
```

Answer `y` to add the marketplace, then choose a scope. From a local checkout, this installs it for every session and reads it straight from the folder, so edits take effect with `/reload-plugins`:

```
claude plugin marketplace add /path/to/claude-mod
claude plugin install step-tracker@gene-claude-mods --scope user
```

To try it for one session only:

```
claude --plugin-dir /path/to/claude-mod
```

## Develop

```
claude plugin validate .
claude plugin test .
```
