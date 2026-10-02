import { expect, test } from 'vitest';

import { fromOpenCode, renderTranscript, type OcMessage } from '../opencode/adapter.js';
import { pruneForCheckpoint, resolveConfig } from '../opencode/index.js';
import type { JevAsker } from '../src/types.js';

const big = 'x'.repeat(5000);

function session(): OcMessage[] {
  const messages: OcMessage[] = [{ role: 'user', content: [{ type: 'text', text: 'Fix the test. Never edit src/gen.' }] }];
  for (let i = 1; i <= 6; i++) {
    messages.push({
      role: 'assistant',
      content: [{ type: 'tool-call', id: `c${i}`, name: 'read', input: { path: `f${i}.ts` } }],
    });
    messages.push({
      role: 'tool',
      content: [{ type: 'tool-result', id: `c${i}`, name: 'read', result: { type: 'text', value: `${i}:${big}` } }],
    });
  }
  messages.push({ role: 'system', content: [{ type: 'text', text: 'catalog changed' }] });
  messages.push({ role: 'assistant', content: [{ type: 'text', text: 'done reading' }] });
  return messages;
}

const dropAll: JevAsker = {
  async ask(_state, questions) {
    const answers: Record<string, { noul: number }> = {};
    for (const name of Object.keys(questions)) answers[name] = { noul: name.startsWith('call_t1') ? 0.9 : 0.1 };
    return { answers };
  },
};

const keepAll: JevAsker = {
  async ask(_state, questions) {
    return { answers: Object.fromEntries(Object.keys(questions).map((n) => [n, { noul: 0.9 }])) };
  },
};

test('maps tool calls and results by id and drops system messages', () => {
  const transcript = fromOpenCode(session());
  expect(transcript.length).toBe(14);
  expect(transcript[1]).toEqual({ role: 'assistant', text: '', toolUses: [{ tool_use_id: 'c1', tool: 'read', input: { path: 'f1.ts' } }] });
  expect(transcript[2]!.toolResults![0]!.tool_use_id).toBe('c1');
  expect(transcript.some((m) => m.text === 'catalog changed')).toBe(false);
});

test('prunes stale calls, keeps user text verbatim, keeps recent calls', async () => {
  const config = resolveConfig({ preserveRecentMessages: 4 }, { TYPESAFE_API_KEY: 'k' });
  const outcome = await pruneForCheckpoint(session(), config, dropAll);
  expect(outcome.kind).toBe('pruned');
  if (outcome.kind !== 'pruned') return;
  const { summary } = outcome;
  expect(summary).toContain('[user]\nFix the test. Never edit src/gen.');
  expect(summary).toContain('[tool call c1: read] {"path":"f1.ts"}');
  expect(summary).toContain('fast-jev-compaction truncated');
  expect(summary).not.toContain('[tool call c2: read]');
  expect(summary).toContain(`[tool result c6: read]\n6:${big}`);
  expect(summary).toContain('[assistant]\ndone reading');
});

test('falls back when the reduction is too small', async () => {
  const config = resolveConfig({}, { TYPESAFE_API_KEY: 'k' });
  const outcome = await pruneForCheckpoint(session(), config, keepAll);
  expect(outcome.kind).toBe('fallback');
});

test('falls back when the checkpoint exceeds maxSummaryChars', async () => {
  const config = resolveConfig({ preserveRecentMessages: 4, maxSummaryChars: 1000 }, { TYPESAFE_API_KEY: 'k' });
  const outcome = await pruneForCheckpoint(session(), config, dropAll);
  expect(outcome.kind).toBe('fallback');
  if (outcome.kind === 'fallback') expect(outcome.reason).toMatch(/^checkpoint /);
});

test('falls back without a key', async () => {
  const outcome = await pruneForCheckpoint(session(), resolveConfig({}, {}), keepAll);
  expect(outcome).toEqual({ kind: 'fallback', reason: 'TYPESAFE_API_KEY is not configured' });
});

test('renders error results', () => {
  const text = renderTranscript(
    fromOpenCode([
      { role: 'assistant', content: [{ type: 'tool-call', id: 'e', name: 'shell', input: { command: 'false' } }] },
      { role: 'tool', content: [{ type: 'tool-result', id: 'e', name: 'shell', result: { type: 'error', value: 'exit 1' } }] },
    ]),
  );
  expect(text).toContain('[tool error e: shell]\nexit 1');
});
