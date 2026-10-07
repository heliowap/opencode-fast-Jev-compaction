import { mkdtemp, rm } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';

import { MemoryArchive } from '../opencode/archive.js';
import type { OcMessage } from '../opencode/adapter.js';
import { pruneForCheckpoint, resolveConfig } from '../opencode/index.js';
import type { JevAsker } from '../src/types.js';

const root = await mkdtemp('/private/tmp/opencode/jev-benchmark-');
const archive = new MemoryArchive(root);
const asker: JevAsker = {
  async ask(_state, questions) {
    return { answers: Object.fromEntries(Object.keys(questions).map((key) => [key, {
      noul: key.startsWith('text_') ? 0.8 : 0.1,
    }])) };
  },
};
const messages: OcMessage[] = [{ id: 'goal', role: 'user', content: [{ type: 'text', text: 'Fix token expiration; preserve generated files.' }] }];
for (let i = 0; i < 160; i++) {
  messages.push({ id: `call-${i}`, role: 'assistant', content: [{ type: 'tool-call', id: `c${i}`, name: 'shell', input: { command: `test-case ${i}` } }] });
  messages.push({ id: `result-${i}`, role: 'tool', content: [{ type: 'tool-result', id: `c${i}`, name: 'shell', result: { type: 'text', value: `fixture-${i}\n${'historical log '.repeat(350)}\nexit 0` } }] });
}
messages.push({ id: 'decision', role: 'assistant', content: [{ type: 'text', text: 'Compare expiration in milliseconds.' }] });
const config = resolveConfig({ preserveRecentMessages: 0 }, {});
const originals = messages.slice();
const important: JevAsker = {
  async ask(_state, questions) {
    return { answers: Object.fromEntries(Object.keys(questions).map((key) => [key, { noul: 0.8 }])) };
  },
};
try {
  for (const mode of ['legacy', 'archive-cold', 'archive-warm', 'checkpoint-resume', 'archive-budget'] as const) {
    const memory = mode === 'legacy' ? undefined : { archive, sessionID: 'benchmark' };
    const start = performance.now();
    const input = mode === 'archive-budget' ? originals : messages;
    const result = await pruneForCheckpoint(input, config, mode === 'archive-budget' ? important : asker, memory);
    if (result.kind !== 'pruned') throw new Error(`${mode}: ${result.reason}`);
    console.log(JSON.stringify({ mode, localMs: Math.round(performance.now() - start),
      inputChars: JSON.stringify(input).length, summaryChars: result.summary.length,
      requests: result.result.stats.requests, inference: 'SIMULATED; no network or Jev latency' }));
    if (result.details) console.log(JSON.stringify(result.details));
    if (mode === 'archive-warm') messages.splice(0, messages.length, {
      id: 'checkpoint', role: 'user', content: [{ type: 'text', text: result.summary }],
      metadata: { fastJevCompaction: { version: 1, manifestID: result.manifestID } },
    });
  }
} finally {
  await rm(root, { recursive: true, force: true });
}
