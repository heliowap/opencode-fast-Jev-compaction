import type { SessionCompaction } from '@opencode/plugin/promise/session';
import { ProviderID } from '@opencode/ai/schema/ids';
import { afterEach, expect, test, vi } from 'vitest';

import type { OcMessage } from '../opencode/adapter.js';
import plugin, { jevAsker, pruneForCheckpoint, resolveConfig } from '../opencode/index.js';
import { resolveOptions } from '../src/compact.js';
import type { JevAsker } from '../src/types.js';

const big = 'x'.repeat(5000);

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

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

test.each([NaN, Infinity, -Infinity, '12', null, undefined])(
  'invalid numeric options (%s) leave the library defaults intact',
  (value) => {
    const config = resolveConfig({
      keepThreshold: value,
      preserveRecentMessages: value,
      maxStateTokens: value,
      maxRequestTokens: value,
      truncateHeadChars: value,
      minReductionRatio: value,
      maxSummaryChars: value,
    }, {});
    expect(config).toEqual({
      provider: 'opencode',
      model: 'jev-1.13-free',
      baseUrl: 'https://opencode.ai/zen/v1/systemone',
      minReductionRatio: 0.25,
      maxSummaryChars: 100000,
    });
    expect(resolveOptions(config)).toEqual({
      goal: '',
      keepThreshold: 0.5,
      preserveRecentMessages: 6,
      maxStateTokens: 25000,
      maxRequestTokens: 30000,
      truncateHeadChars: 300,
    });
  },
);

test('valid numeric options, including zero, are preserved', () => {
  const config = resolveConfig({
    keepThreshold: 0,
    preserveRecentMessages: 0,
    maxStateTokens: 1234,
    maxRequestTokens: 5678,
    truncateHeadChars: 0,
    minReductionRatio: 0,
    maxSummaryChars: 0,
  }, {});
  expect(config).toMatchObject({
    keepThreshold: 0,
    preserveRecentMessages: 0,
    maxStateTokens: 1234,
    maxRequestTokens: 5678,
    truncateHeadChars: 0,
    minReductionRatio: 0,
    maxSummaryChars: 0,
  });
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

test('falls back without asking Jev when the history holds an encrypted checkpoint', async () => {
  const asked: unknown[] = [];
  const spy: JevAsker = {
    async ask(state, questions) {
      asked.push(questions);
      return dropAll.ask(state, questions);
    },
  };
  const messages: OcMessage[] = [
    { role: 'assistant', content: [{ type: 'compaction', provider: ProviderID.make('openai'), encrypted: 'opaque' }] },
    ...session(),
  ];
  const outcome = await pruneForCheckpoint(messages, resolveConfig({ preserveRecentMessages: 4 }, {}), spy);
  expect(outcome).toEqual({ kind: 'fallback', reason: 'encrypted compaction checkpoint' });
  expect(asked).toEqual([]);
});

test('falls back when TypeSafe is forced without a key', async () => {
  const outcome = await pruneForCheckpoint(session(), resolveConfig({ provider: 'typesafe' }, {}), keepAll);
  expect(outcome).toEqual({ kind: 'fallback', reason: 'TYPESAFE_API_KEY is not configured' });
});

test('the asker omits authorization without a key and sends the Zen model', async () => {
  const seen: { url: string; init: RequestInit }[] = [];
  const fake: typeof fetch = async (url, init) => {
    seen.push({ url: String(url), init: init ?? {} });
    return new Response('{"answers":{}}', { status: 200 });
  };
  const signal = new AbortController().signal;
  const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(signal);
  await expect(jevAsker(resolveConfig({}, {}), fake).ask('s', {})).resolves.toEqual({ answers: {} });
  expect(seen[0]!.url).toBe('https://opencode.ai/zen/v1/systemone');
  expect(seen[0]!.init.method).toBe('POST');
  expect(seen[0]!.init.headers).toEqual({ 'content-type': 'application/json' });
  expect(JSON.parse(String(seen[0]!.init.body))).toEqual({ model: 'jev-1.13-free', state: 's', questions: {} });
  expect(seen[0]!.init.signal).toBe(signal);
  expect(timeout).toHaveBeenCalledWith(60000);
});

test.each([
  [{ TYPESAFE_API_KEY: 't' }, 'https://api.typesafe.ai/v1/systemone', 'jev-latest', 't'],
  [{ OPENCODE_API_KEY: 'o' }, 'https://opencode.ai/zen/v1/systemone', 'jev-1.13-free', 'o'],
])('the asker sends the configured provider key (%j)', async (env, url, model, key) => {
  const fake = vi.fn<typeof fetch>(async () => new Response('{"answers":{"q":{"noul":0.4}}}'));
  const questions = { q: { type: 'noul' as const, instructions: 'keep this?' } };
  await expect(jevAsker(resolveConfig({}, env), fake).ask('state', questions)).resolves.toEqual({
    answers: { q: { noul: 0.4 } },
  });
  expect(fake).toHaveBeenCalledWith(url, expect.objectContaining({
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model, state: 'state', questions }),
    signal: expect.any(AbortSignal),
  }));
});

async function setupHook(options: Record<string, unknown>) {
  let hook: ((event: SessionCompaction) => Promise<void> | void) | undefined;
  const set = vi.fn(async () => { throw new Error('storage unavailable'); });
  const register: Parameters<typeof plugin.setup>[0]['session']['hook'] = async (name, callback) => {
    expect(name).toBe('compaction');
    // This fixture registers only compaction; the SDK's generic callback cannot narrow by name.
    hook = callback as typeof hook;
    return { dispose: async () => {} };
  };
  const ctx = {
    options,
    session: { hook: register },
    storage: { set },
  } satisfies Parameters<typeof plugin.setup>[0];
  await plugin.setup(ctx);
  if (!hook) throw new Error('compaction hook was not registered');
  // The hook reads only sessionID and messages and writes result.
  const event = { sessionID: 'session-test', messages: session() } as SessionCompaction;
  return { hook, event, set };
}

test('a rejecting diagnostic store does not prevent a successful checkpoint', async () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (_input, init) => {
    const { state, questions } = JSON.parse(String(init?.body));
    return new Response(JSON.stringify(await dropAll.ask(state, questions)));
  }));
  const { hook, event, set } = await setupHook({ provider: 'opencode', preserveRecentMessages: 4 });
  await expect(hook(event)).resolves.toBeUndefined();
  expect(event.result?.summary).toContain('[user]\nFix the test. Never edit src/gen.');
  expect(event.result?.summary).not.toContain('[tool call c2: read]');
  expect(event.result?.metadata?.fastJevCompaction).toMatchObject({ callsDropped: 3, resultsDropped: 1 });
  expect(set).toHaveBeenCalledWith('last/session-test', expect.objectContaining({ kind: 'pruned', reason: null }));
  expect(log).toHaveBeenCalledWith(expect.stringMatching(/^\[fast-jev-compaction\] Jev: /));
  expect(warn).toHaveBeenCalledWith('[fast-jev-compaction] could not persist diagnostics: storage unavailable');
});

test('a rejecting diagnostic store does not prevent the built-in fallback', async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (_input, init) => {
    const { state, questions } = JSON.parse(String(init?.body));
    return new Response(JSON.stringify(await keepAll.ask(state, questions)));
  }));
  const { hook, event, set } = await setupHook({ provider: 'opencode' });
  await expect(hook(event)).resolves.toBeUndefined();
  expect(event).not.toHaveProperty('result');
  expect(set).toHaveBeenCalledWith('last/session-test', expect.objectContaining({
    kind: 'fallback', reason: 'reduction 0% below 25%',
  }));
  expect(warn).toHaveBeenCalledWith('[fast-jev-compaction] fallback to built-in summary: reduction 0% below 25%');
});

test('a transport failure leaves the hook result unset', async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => { throw new Error('network unavailable'); }));
  const { hook, event, set } = await setupHook({ provider: 'opencode' });
  await expect(hook(event)).resolves.toBeUndefined();
  expect(event).not.toHaveProperty('result');
  expect(set).toHaveBeenCalledWith('last/session-test', expect.objectContaining({
    kind: 'fallback', reason: 'network unavailable', stats: {},
  }));
  expect(warn).toHaveBeenCalledWith('[fast-jev-compaction] fallback to built-in summary: network unavailable');
});
