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

Each text, media, tool-call and tool-result part becomes its own block, in the original order, so
text written around a tool call stays around it. Attachments are described by media type, filename
and source. `system` messages (OpenCode-injected updates; the system prompt is re-sent after
compaction), plain reasoning (providers do not replay it) and effort settings are left out.

`preserveRecentMessages` counts these blocks, not OpenCode messages. OpenCode also keeps its own
recent window (`compaction.keep.tokens`) beside the checkpoint, as with the built-in summary.

There is no auto-compaction trigger; OpenCode's own `compaction.auto` decides when to compact.

## Fallback

The hook leaves the result unset, so OpenCode writes its built-in summary, when:

- the `typesafe` provider is forced without a key;
- the history holds content that cannot be rendered as text without loss: an encrypted compaction
  checkpoint (OpenAI Responses native compaction), a checkpoint without text, or encrypted
  reasoning;
- Jev fails, answers malformed, or takes more than 60 s;
- the reduction is below `minReductionRatio`;
- the checkpoint is longer than `maxSummaryChars`. The previous checkpoint returns as the pinned
  first message and text is never pruned, so checkpoints only grow; the cap lets the built-in
  summary reset them.

The reason is logged as a warning. The outcome of the last compaction per session is kept in the
plugin storage under `last/<sessionID>` on a best-effort basis. Storage failures are logged and do
not prevent either compaction or fallback. Successful runs add `metadata.fastJevCompaction` to the
compaction message.

## Install

```sh
opencode plugin add github:heliowap/opencode-fast-Jev-compaction
```

This installs the package from git and adds it to `plugins` in the global `opencode.jsonc`. No npm
publish or build step is involved: OpenCode loads `opencode/index.ts` through the package's
`./server` export, and the plugin has no runtime dependencies. Pin a commit with
`github:heliowap/opencode-fast-Jev-compaction#<sha>`; `opencode plugin update` refreshes an unpinned
install.

To remove it, run `opencode plugin remove github:heliowap/opencode-fast-Jev-compaction`.

## Where Jev runs

| Environment | Endpoint | Model |
| --- | --- | --- |
| `TYPESAFE_API_KEY` set | TypeSafe (`api.typesafe.ai`) | `jev-latest` |
| no TypeSafe key | OpenCode Zen (`opencode.ai/zen`) | `jev-1.13-free`, no key needed |
| no TypeSafe key, `OPENCODE_API_KEY` set | OpenCode Zen, with that key | `jev-1.13-free` |

Set `provider` (`"typesafe"` or `"opencode"`) to force either. Installs that take no options can use
the `FAST_JEV_PROVIDER` environment variable instead. The plugin logs its choice at startup, for
example `[fast-jev-compaction] Jev: jev-1.13-free via OpenCode Zen (no key)`.

These keys must be in the OpenCode service's environment, not only in the shell that runs the client.

OpenCode describes `jev-1.13-free` as available "for a limited time". Zen's privacy section says Jev
prompts are not used for training and are retained under TypeSafe's privacy policy. Zen's paid
`jev-1.13` needs a funded Zen balance; select it with `"model": "jev-1.13"`.

## Options

Pass options with the object form in `opencode.json(c)`:

```jsonc
{
  "plugins": [
    {
      "package": "github:heliowap/opencode-fast-Jev-compaction",
      "options": { "provider": "opencode", "keepThreshold": 0.5 }
    }
  ]
}
```

| Option | Default | Description |
| --- | --- | --- |
| `provider` | `typesafe` with a TypeSafe key, else `opencode` | Where Jev runs |
| `apiKey` | `TYPESAFE_API_KEY`, or `OPENCODE_API_KEY` on Zen | API key for the provider |
| `model` | `jev-latest`, or `jev-1.13-free` on Zen | Jev model name |
| `baseUrl` | the provider's System One endpoint | Jev endpoint |
| `keepThreshold` | `0.5` | Minimum keep probability for a call or result |
| `preserveRecentMessages` | `6` | Newest messages never touched (the first is always kept) |
| `maxStateTokens` | `25000` | Estimated token ceiling for the state |
| `maxRequestTokens` | `30000` | Estimated ceiling for state plus one batch of questions |
| `truncateHeadChars` | `300` | Characters of a dropped tool result retained before its note |
| `minReductionRatio` | `0.25` | Below this reduction, fall back to the built-in summary |
| `maxSummaryChars` | `100000` | Above this checkpoint size, fall back to the built-in summary |

Missing, non-number, and non-finite numeric options use the defaults above.

## Development

```sh
npm install
npm run typecheck:opencode
npx vitest run tests/opencode.test.ts
```

The package has no `build` or `prepare` script on purpose. When it installs a git dependency, npm
runs a full `npm install` in the clone if one of those scripts is present, and OpenCode's installer
fails with "git dep preparation failed". The TypeScript compile is `npm run compile`.

Tested against OpenCode 2.0.22 and `@opencode/plugin` 2.0.22.
