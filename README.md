# step-tracker

A Claude Code mod that shows, live, the steps Claude is working through, which one is active, and what it is doing right now.

It draws a **Steps** panel directly above the prompt input (collapsible with the `[-]` mark) and a one-line summary on the status line. `/steps pane` shows the same tracker as a pane instead (a sidebar in the fullscreen terminal). The mod registers two tools of its own, `plan` and `step`, and asks Claude to record multi-step work with them in three places, so it works on every build: a short system-prompt section, a reminder attached beside every prompt you send (Claude reads it, you never see it), and one more reminder after a job's second tool call when no plan was recorded yet. When Claude's built-in task tools (`TaskCreate`, `TaskUpdate`, `TodoWrite`) are present and used, those are mirrored into the list as well. Tool calls and running subagents appear under **Now** as they happen. Every prompt is a new job, labelled with a one-line excerpt of its prompt; when the row cannot show all of it, a **[more]** button shows the whole prompt and **[less]** folds it back. A new prompt heads the panel at once with an empty list. The ◀ ▶ arrows at the top right of the panel page back through earlier jobs (prompt and steps, with a `Job 2/5` counter) and forward again to the live one; a new prompt returns the panel to the live job. `/steps history` opens every earlier job at once in a pane.

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
