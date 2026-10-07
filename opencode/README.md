# OpenCode V2 plugin

Uses OpenCode's `compaction` session hook to select a bounded, recoverable checkpoint instead of
asking a generative model to summarize. Jev scores old tool calls, outputs and assistant prose.
Original blocks are archived locally **before** anything leaves the active context. Kept blocks
stay verbatim and in order. No embeddings, database server or extra summary model is required.

## How it differs from the Claude Code hook

OpenCode V2 accepts only text as a compaction result (`event.result.summary`); it cannot take a
replacement message list. The pruned transcript is therefore rendered as text inside the checkpoint:

```text
[user]
Fix the failing test. Never edit src/generated.

[tool call call_1: read] {"path":"src/a.ts"}

[tool result call_1: read]
…verbatim, or a bounded prefix and a stable archive ID…

[assistant]
The bug is in a.ts.
```

Each text, media, tool-call and tool-result part becomes its own block, in the original order, so
text written around a tool call stays around it. Attachments are described by media type, filename
and source. `system` messages (OpenCode-injected updates; the system prompt is re-sent after
compaction), plain reasoning (providers do not replay it) and effort settings are left out.
Media remain descriptors in the text checkpoint; encoded sources are archived, but reads do not
reattach images and expiring remote URLs are not downloaded/materialized. Host cache hints are not
historical content and are excluded from archived identities.

All user text, the first block, media/checkpoint blocks, unpaired tools and the newest protected
blocks remain active. Old assistant prose and complete call/result pairs are candidates. Jev sees
bounded head/tail previews of the actual evidence, not just output lengths. Every candidate remains
visible in its request; evidence and questions are batched together under both Jev ceilings, with
at most four requests in flight. Previews are not full-output comprehension guarantees.

Low-scoring blocks are archived first. If more space is needed, eligible blocks are removed in
ascending relevance order. Protected blocks are never removed to make the budget fit. Content is
not discarded merely because it might be in a model's training data. This hook does not unload
host-owned tool schemas, mandatory instructions or skills.

`preserveRecentMessages` counts these blocks, not OpenCode messages. OpenCode also keeps its own
recent window (`compaction.keep.tokens`) beside the checkpoint, as with the built-in summary.

There is no auto-compaction trigger; OpenCode's own `compaction.auto` decides when to compact.

## Memory and repeated compactations

By default, originals and immutable manifests are JSON files under `.jev-memory/` in the session's
directory. References use session-scoped stable IDs, not mutable Markdown line numbers. Source
message/part identities prevent duplicate writes when available; messages without source IDs get
occurrence-specific IDs. The full catalog stays on disk, not in the checkpoint.

A new checkpoint contains one versioned manifest reference, selected blocks and only useful output
pointers. On the next round, the plugin resolves its **metadata-tagged** manifest and rebuilds from
originals; it does not nest or reparse the previous dump. Assessments are reused only while the
user-task fingerprint and Jev model/provider are unchanged. Archived blocks are recovered on demand,
not rescored by scanning the entire archive each round.

Tools available to the agent:

- `fast_jev_memory_search(query, limit)`: lexical search in this session, at most 10 snippets.
- `fast_jev_memory_read(id, offset, limit)`: original text/structured evidence, at most 8000 characters;
  follow `nextOffset` to continue. Offsets and limits are **characters**, not tokens or lines.
- `fast_jev_status()`: last outcome, timings, estimated size, budget assumptions and fallback reason.

Search is local and lexical, not semantic or indexed SQL search. Its initial implementation scans
archive records; very large sessions may need a separate search index later. It is not on the
mandatory compaction path. Recovery tools do not accept arbitrary paths or another session ID.
Forked sessions do not automatically inherit access to the parent's archive; an inherited pointer
that cannot be resolved falls back safely. Native/legacy textual checkpoints are kept as opaque
protected text: their discarded originals cannot be reconstructed retroactively.
The host's separately retained `<recent-context>` also arrives as serialized text, not structured
parts. It is preserved as an opaque protected block rather than unsafely parsing user/tool labels.
That protected floor can still grow and require native fallback; this is not yet a complete
hierarchical memory replacement for every part of an OpenCode session.

The plugin remembers the archive root using OpenCode's existing plugin storage, so moving a session
does not silently redirect its pointers. Do not delete archives referenced by resumable sessions.
There is no automatic expiration or pruning. Back them up together with the session data.

**Privacy:** originals can contain credentials and other sensitive data. They are local plaintext,
not encrypted or automatically redacted. Directories/files use private permissions and reject
symlinks, but `.gitignore` and permissions do not protect against backups or other processes running
as your user. To avoid new archive writes, use `memory: false` (legacy tool-only mode).
The archive creates an internal `.gitignore` so it is ignored even in projects without a root-level
rule. Use a dedicated `memoryDirectory`, never an existing project/home directory.

## Checkpoint budget

Acceptance depends on final rendered size, including instructions and pointers, not percentage
reduction. The plugin caps `maxSummaryTokens` using the selected model's input/context limit when
available, subtracting estimated system/tool overhead and configured recent/working reserves.
It also honors `maxSummaryChars`. `minReductionRatio` is retained for configuration compatibility
but no longer rejects fitting checkpoints.

Checkpoint tokens are conservatively estimated as the larger of the library estimate and
`ceil(characters / 3)`. This is **not** the provider's tokenizer. The hook does not expose the actual
separately retained tail or resolved OpenCode compaction buffer; the default 20k-token tail reserve
is an explicit assumption, not a fit guarantee. Increase it when using a larger native keep window.
For small input windows, configure smaller reserves only if the actual tail/workload permits it.
If model lookup is unavailable, the configured checkpoint target still applies and diagnostics say
so. `event.options.maxTokens` is an output setting and is not used as an input budget.

## Fallback

The hook leaves the result unset, so OpenCode writes its built-in summary, when:

- the `typesafe` provider is forced without a key;
- the history holds content that cannot be rendered as text without loss: an encrypted compaction
  checkpoint (OpenAI Responses native compaction), a checkpoint without text, or encrypted
  reasoning;
- Jev fails, answers malformed, or an individual request takes more than 60 s. Each request has its
  own timeout; multiple waves of batches can make total inference time exceed 60 s;
- archive/root-registration persistence fails, or a referenced manifest is missing, corrupt,
  unsupported or belongs to another session;
- the protected context alone exceeds the estimated budget (detected before inference in
  recoverable mode; legacy `memory: false` checks the final checkpoint after tool classification);
- the final checkpoint cannot fit `maxSummaryTokens` or `maxSummaryChars`.

The reason is logged as a warning. The outcome of the last compaction per session is kept in the
plugin storage under `last/<sessionID>` on a best-effort basis. **Diagnostic** write failures do not
prevent compaction; original/manifest/root-registration failures do. Successful runs add
`metadata.fastJevCompaction`, including the manifest and timings, to the compaction message.

The full checkpoint is still displayed by OpenCode's built-in compaction renderer. The supported
2.0.22 CLI plugin interface cannot replace just that body. This fork does not claim to hide the dump
or replace the internal memory with a short UI label.

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
| `goal` | protected user history | Additional current-task description; user revisions still count |
| `memory` | `true` | Recoverable selection; `false` uses legacy tool-only pruning |
| `memoryDirectory` | `.jev-memory` | Local archive path, initially resolved against the session directory |
| `maxSummaryTokens` | `20000` | Estimated final checkpoint target, further capped by model limits |
| `recentReserveTokens` | `20000` | Assumed allowance for the host's separately retained tail |
| `workingReserveTokens` | `10000` | Space reserved for continuation and framing |
| `minReductionRatio` | `0.25` | Deprecated compatibility option; reduction is diagnostic only |
| `maxSummaryChars` | `100000` | Additional final checkpoint character cap |

Missing, non-number, and non-finite numeric options use the defaults above.

## Development

```sh
npm install
npm run typecheck:opencode
npx vitest run tests/opencode.test.ts
npm run benchmark:opencode
```

The package has no `build` or `prepare` script on purpose. When it installs a git dependency, npm
runs a full `npm install` in the clone if one of those scripts is present, and OpenCode's installer
fails with "git dep preparation failed". The TypeScript compile is `npm run compile`.

Tested against OpenCode 2.0.22 and `@opencode/plugin` 2.0.22.

The benchmark uses synthetic history and **simulated** Jev answers, without network/inference
latency. It compares legacy pruning, cold/warm archives and checkpoint resume. It measures local
overhead, not real model latency or task quality. Validate live continuation, exact fact recovery,
fallback rate, provider tokens and total task time separately before claiming a speed/quality gain.
