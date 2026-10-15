# gene-claude-mods

Claude Code mods, published as one marketplace. Each mod lives in its own folder under `plugins/`.

| Mod | What it does |
| --- | --- |
| [step-tracker](plugins/step-tracker) | Live panel and status line showing the steps Claude is working through, which one is active, and what it is doing right now. |
| [next-prompt](plugins/next-prompt) | Better guesses for your next prompt: several ranked choices, cleaned up, and learned from what you actually type. |

## Install

```
/plugin install <mod> --marketplace sr-gene/gene-claude-mods
```

From a local checkout:

```
claude plugin marketplace add /path/to/gene-claude-mods
claude plugin install <mod>@gene-claude-mods --scope user
```

## Develop

From the repository root:

```
claude plugin validate plugins/<mod>
claude plugin test plugins/<mod>
```
