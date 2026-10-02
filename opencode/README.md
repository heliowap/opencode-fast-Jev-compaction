# OpenCode V2 plugin

Runs the library in `../src` from OpenCode's `compaction` session hook. When OpenCode compacts a
session, the plugin asks Jev which old tool calls and results can go, and stores the pruned
conversation as the checkpoint in place of the model-written summary. User and assistant text stays
verbatim and in order.

## How it differs from the Claude Code hook

OpenCode V2 accepts only text as a compaction result (`event.result.summary`); it cannot take a
replacement message list. The pruned transcript is therefore rendered as text inside the checkpoint:

```text
[user]
Fix the failing test. Never edit src/generated.

[tool call call_1: read] {"path":"src/a.ts"}

[tool result call_1: read]
…verbatim, or the first truncateHeadChars characters and a truncation note…

[assistant]
The bug is in a.ts.
```

OpenCode keeps its usual recent window (`compaction.keep.tokens`) beside the checkpoint, as with
the built-in summary. `system` messages and reasoning are left out of the checkpoint.

There is no auto-compaction trigger; OpenCode's own `compaction.auto` decides when to compact.

## Fallback

The hook leaves the result unset, so OpenCode writes its built-in summary, when:

- `TYPESAFE_API_KEY` (or the `apiKey` option) is missing;
- Jev fails, answers malformed, or takes more than 60 s;
- the reduction is below `minReductionRatio`;
- the checkpoint is longer than `maxSummaryChars`. The previous checkpoint returns as the pinned
  first message and text is never pruned, so checkpoints only grow; the cap lets the built-in
  summary reset them.

The reason is logged as a warning. The outcome of the last compaction per session is kept in the
plugin storage under `last/<sessionID>`, and successful runs add `metadata.fastJevCompaction` to the
compaction message.

## Install

The plugin has no runtime dependencies. Copy `opencode/` and `src/` side by side into OpenCode's
global plugin directory, keeping the relative import:

```sh
git clone https://github.com/heliowap/opencode-fast-Jev-compaction.git
mkdir -p ~/.config/opencode/plugins/fast-jev-compaction
cp -R opencode-fast-Jev-compaction/{opencode,src,LICENSE} ~/.config/opencode/plugins/fast-jev-compaction/
printf "export { default } from './opencode/index.js';\n" \
  > ~/.config/opencode/plugins/fast-jev-compaction/index.ts
```

OpenCode discovers the directory and loads its `index.ts` with default options. In OpenCode
2.0.22, a `main` field in `package.json` was not enough for discovery; the root `index.ts` is. The OpenCode service
must have `TYPESAFE_API_KEY` in its environment; a service started without it always falls back.

To disable the plugin, delete the directory or add `"-fast-jev-compaction"` to `plugins`.

## Options

To pass options, copy the files to a directory outside `plugins/` and load it with the object form
in `opencode.json(c)`, using an absolute path:

```jsonc
{
  "plugins": [
    {
      "package": "/absolute/path/to/fast-jev-compaction",
      "options": { "keepThreshold": 0.5, "minReductionRatio": 0.25 }
    }
  ]
}
```

| Option | Default | Description |
| --- | --- | --- |
| `apiKey` | `TYPESAFE_API_KEY` | TypeSafe API key |
| `model` | `jev-latest` | Jev model name |
| `baseUrl` | System One endpoint | Jev endpoint |
| `keepThreshold` | `0.5` | Minimum keep probability for a call or result |
| `preserveRecentMessages` | `6` | Newest messages never touched (the first is always kept) |
| `maxStateTokens` | `25000` | Estimated token ceiling for the state |
| `maxRequestTokens` | `30000` | Estimated ceiling for state plus one batch of questions |
| `truncateHeadChars` | `300` | Characters of a dropped tool result retained before its note |
| `minReductionRatio` | `0.25` | Below this reduction, fall back to the built-in summary |
| `maxSummaryChars` | `100000` | Above this checkpoint size, fall back to the built-in summary |

## Development

```sh
npm install
npm run typecheck:opencode
npx vitest run tests/opencode.test.ts
```

Tested against OpenCode 2.0.22 and `@opencode/plugin` 2.0.22.
