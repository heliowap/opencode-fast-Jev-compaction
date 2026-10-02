import { expect, test } from 'vitest';

import { fromOpenCode, renderTranscript, type OcMessage } from '../opencode/adapter.js';
import { jevAsker, pruneForCheckpoint, resolveConfig } from '../opencode/index.js';
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

test('uses TypeSafe when a TypeSafe key is set', () => {
  const config = resolveConfig({}, { TYPESAFE_API_KEY: 't', OPENCODE_API_KEY: 'o' });
  expect(config).toMatchObject({ provider: 'typesafe', apiKey: 't', model: 'jev-latest' });
  expect(config.baseUrl).toBeUndefined();
});

test('uses the free Jev on OpenCode Zen without any key', () => {
  const config = resolveConfig({}, {});
  expect(config).toMatchObject({
    provider: 'opencode',
    model: 'jev-1.13-free',
    baseUrl: 'https://opencode.ai/zen/v1/systemone',
  });
  expect(config.apiKey).toBeUndefined();
});

test('sends OPENCODE_API_KEY to Zen when set', () => {
  expect(resolveConfig({}, { OPENCODE_API_KEY: 'o' })).toMatchObject({ provider: 'opencode', apiKey: 'o' });
});

test('provider option and FAST_JEV_PROVIDER force the provider', () => {
  expect(resolveConfig({ provider: 'opencode' }, { TYPESAFE_API_KEY: 't' })).toMatchObject({
    provider: 'opencode',
    model: 'jev-1.13-free',
  });
  expect(resolveConfig({}, { TYPESAFE_API_KEY: 't', FAST_JEV_PROVIDER: 'opencode' }).provider).toBe('opencode');
  expect(resolveConfig({ provider: 'typesafe' }, { FAST_JEV_PROVIDER: 'opencode' }).provider).toBe('typesafe');
});

test('prunes through Zen without a key', async () => {
  const config = resolveConfig({ preserveRecentMessages: 4 }, {});
  expect((await pruneForCheckpoint(session(), config, dropAll)).kind).toBe('pruned');
});

test('falls back when TypeSafe is forced without a key', async () => {
  const outcome = await pruneForCheckpoint(session(), resolveConfig({ provider: 'typesafe' }, {}), keepAll);
  expect(outcome).toEqual({ kind: 'fallback', reason: 'TYPESAFE_API_KEY is not configured' });
});

test('the asker omits authorization without a key and sends the Zen model', async () => {
  const seen: { url: string; init: RequestInit }[] = [];
  const fake = (async (url: string, init: RequestInit) => {
    seen.push({ url, init });
    return new Response('{"answers":{}}', { status: 200 });
  }) as unknown as typeof fetch;
  await jevAsker(resolveConfig({}, {}), fake).ask('s', {});
  expect(seen[0]!.url).toBe('https://opencode.ai/zen/v1/systemone');
  expect(seen[0]!.init.headers).toEqual({ 'content-type': 'application/json' });
  expect(JSON.parse(String(seen[0]!.init.body)).model).toBe('jev-1.13-free');
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
