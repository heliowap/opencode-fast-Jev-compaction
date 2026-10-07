import type { SessionCompaction } from '@opencode/plugin/promise/session';
import { ProviderID } from '@opencode/ai/schema/ids';
import { afterEach, expect, test, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Info } from '@opencode/plugin/promise/tool';

import type { OcMessage } from '../opencode/adapter.js';
import plugin, { jevAsker, pruneForCheckpoint, resolveConfig } from '../opencode/index.js';
import { resolveOptions } from '../src/compact.js';
import type { JevAsker } from '../src/types.js';

const big = 'x'.repeat(5000);
const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
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

test('accepts a fitting checkpoint even when the reduction is zero', async () => {
  const config = resolveConfig({}, { TYPESAFE_API_KEY: 'k' });
  const outcome = await pruneForCheckpoint(session(), config, keepAll);
  expect(outcome.kind).toBe('pruned');
});

test('falls back when the checkpoint exceeds maxSummaryChars', async () => {
  const config = resolveConfig({ preserveRecentMessages: 4, maxSummaryChars: 1000 }, { TYPESAFE_API_KEY: 'k' });
  const outcome = await pruneForCheckpoint(session(), config, dropAll);
  expect(outcome.kind).toBe('fallback');
  if (outcome.kind === 'fallback') expect(outcome.reason).toMatch(/^checkpoint /);
});

test('measures the rendered checkpoint against its token budget', async () => {
  const config = resolveConfig({ maxSummaryTokens: 1000 }, {});
  const outcome = await pruneForCheckpoint(session(), config, keepAll);
  expect(outcome.kind).toBe('fallback');
  if (outcome.kind === 'fallback') expect(outcome.reason).toMatch(/estimated tokens above 1000/);
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
      maxSummaryTokens: 20000,
      memory: true,
      memoryDirectory: '.jev-memory',
      recentReserveTokens: 20000,
      workingReserveTokens: 10000,
      goal: undefined,
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
  const root = await mkdtemp('/private/tmp/opencode/jev-plugin-');
  roots.push(root);
  const tools: Info[] = [];
  let hook: ((event: SessionCompaction) => Promise<void> | void) | undefined;
  const values = new Map<string, unknown>();
  const set = vi.fn(async (key: string, value: unknown) => {
    if (key.startsWith('last/')) throw new Error('storage unavailable');
    values.set(key, value);
  });
  const register: Parameters<typeof plugin.setup>[0]['session']['hook'] = async (name, callback) => {
    expect(name).toBe('compaction');
    // This fixture registers only compaction; the SDK's generic callback cannot narrow by name.
    hook = callback as typeof hook;
    return { dispose: async () => {} };
  };
  const ctx = {
    options: { memory: false, ...options },
    session: { hook: register, get: vi.fn(async () => ({ location: { directory: root } } as Awaited<ReturnType<Parameters<typeof plugin.setup>[0]['session']['get']>>)) },
    storage: { set, get: vi.fn(async (key: string) => values.get(key)) },
    model: { list: vi.fn(async () => ({ data: [], location: { directory: root } })) },
    tool: { transform: async (edit) => {
      edit({ add: (tool) => { tools.push(tool); }, list: () => [], get: () => undefined,
        namespace: () => {}, remove: () => {}, update: () => {} });
      return { dispose: async () => {} };
    } },
  } satisfies Parameters<typeof plugin.setup>[0];
  await plugin.setup(ctx);
  if (!hook) throw new Error('compaction hook was not registered');
  // The hook reads only sessionID and messages and writes result.
  const event = { sessionID: 'session-test', messages: session(), model: { providerID: 'example', id: 'model' }, system: [], tools: {} } as unknown as SessionCompaction;
  return { hook, event, set, tools, ctx, root };
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
  const { hook, event, set } = await setupHook({ provider: 'opencode', maxSummaryChars: 1000 });
  await expect(hook(event)).resolves.toBeUndefined();
  expect(event).not.toHaveProperty('result');
  expect(set).toHaveBeenCalledWith('last/session-test', expect.objectContaining({
    kind: 'fallback', reason: expect.stringMatching(/^checkpoint /),
  }));
  expect(warn).toHaveBeenCalledWith(expect.stringMatching(/^\[fast-jev-compaction\] fallback to built-in summary: checkpoint /));
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

test('the plugin persists originals and exposes session-scoped recovery even when diagnostics fail', async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (_input, init) => {
    const { state, questions } = JSON.parse(String(init?.body));
    return new Response(JSON.stringify(await dropAll.ask(state, questions)));
  }));
  const { hook, event, tools } = await setupHook({ memory: true, preserveRecentMessages: 4 });
  await hook(event);
  expect(event.result?.metadata?.fastJevCompaction).toMatchObject({ version: 1, manifestID: expect.any(String) });
  expect(event.result?.summary).not.toContain('[tool call c2: read]');
  const search = tools.find((tool) => tool.name === 'fast_jev_memory_search')!;
  const read = tools.find((tool) => tool.name === 'fast_jev_memory_read')!;
  const call = { sessionID: event.sessionID } as Parameters<Info['execute']>[1];
  const found = await search.execute({ query: 'c2', limit: 10 }, call);
  const hits = JSON.parse(String(found.content));
  expect(hits.length).toBeGreaterThan(0);
  const recovered = await read.execute({ id: hits[0].id, limit: 8000 }, call);
  expect(String(recovered.content)).toContain('c2');
});

test('an archive failure leaves the native compaction path available without inference', async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const fetcher = vi.fn<typeof fetch>();
  vi.stubGlobal('fetch', fetcher);
  const { hook, event, root, set } = await setupHook({ memory: true });
  await writeFile(join(root, '.jev-memory'), 'not a directory');
  await expect(hook(event)).resolves.toBeUndefined();
  expect(event.result).toBeUndefined();
  expect(fetcher).not.toHaveBeenCalled();
  expect(set).toHaveBeenCalledWith('last/session-test', expect.objectContaining({ kind: 'fallback' }));
});

test('caps the checkpoint budget using the selected model and explicit reserves', async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (_input, init) => {
    const { state, questions } = JSON.parse(String(init?.body));
    return new Response(JSON.stringify(await keepAll.ask(state, questions)));
  }));
  const { hook, event, ctx, set } = await setupHook({
    memory: false, recentReserveTokens: 1000, workingReserveTokens: 1000,
  });
  ctx.model.list.mockResolvedValue({ data: [{
    providerID: 'example', id: 'model', limit: { context: 8000, input: 4000, output: 500 },
  }] as Awaited<ReturnType<typeof ctx.model.list>>['data'], location: { directory: '/unused' } });
  await hook(event);
  expect(event.result).toBeUndefined();
  expect(set).toHaveBeenCalledWith('last/session-test', expect.objectContaining({
    kind: 'fallback', budgetTokens: expect.any(Number),
    budgetSource: 'model limit minus estimated system/tools and configured reserves',
  }));
  const record = set.mock.calls.find(([key]) => key === 'last/session-test')![1] as { budgetTokens: number };
  expect(record.budgetTokens).toBeLessThan(2000);
});

test('manual compaction preserves a large native checkpoint that fits the model instead of falling back', async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const fetcher = vi.fn<typeof fetch>(async (_input, init) => {
    const { state, questions } = JSON.parse(String(init?.body));
    return new Response(JSON.stringify(await dropAll.ask(state, questions)));
  });
  vi.stubGlobal('fetch', fetcher);
  const { hook, event, ctx, set, tools } = await setupHook({ memory: true });
  ctx.model.list.mockResolvedValue({ data: [{
    providerID: 'example', id: 'model', limit: { context: 400000, input: 272000, output: 128000 },
  }] as Awaited<ReturnType<typeof ctx.model.list>>['data'], location: { directory: '/unused' } });
  const opaque = `<conversation-checkpoint>\n<summary>\nPrevious native summary.\n</summary>\n\n<recent-context>\n[User]: Never remove audit logs.\n[Tool result]: ${'historical evidence '.repeat(7000)}\n</recent-context>\n</conversation-checkpoint>`;
  const staleText = 'Obsolete investigation of the discarded approach. '.repeat(1500);
  event.messages = [
    { role: 'user', content: [{ type: 'text', text: opaque }] },
    { role: 'assistant', content: [{ type: 'text', text: staleText }] },
    ...Array.from({ length: 6 }, () => ({ role: 'assistant', content: [{ type: 'text', text: 'Current protected progress.' }] })),
  ] as SessionCompaction['messages'];
  await hook(event);
  expect(set).toHaveBeenCalledWith('last/session-test', expect.objectContaining({ kind: 'pruned' }));
  expect(event.result?.summary).toContain(opaque);
  expect(event.result?.summary).not.toContain(staleText);
  expect(fetcher).toHaveBeenCalled();
  const search = tools.find((tool) => tool.name === 'fast_jev_memory_search')!;
  const read = tools.find((tool) => tool.name === 'fast_jev_memory_read')!;
  const call = { sessionID: event.sessionID } as Parameters<Info['execute']>[1];
  const found = JSON.parse(String((await search.execute({ query: 'Obsolete investigation' }, call)).content));
  expect(found.length).toBeGreaterThan(0);
  expect(String((await read.execute({ id: found[0].id, limit: 8000 }, call)).content)).toContain('discarded approach');
});

test.each([
  { maxSummaryTokens: 20000, maxSummaryChars: 500000 },
  { maxSummaryTokens: 100000, maxSummaryChars: 100000 },
])('explicit checkpoint limits remain mandatory with a large model (%j)', async (limits) => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const fetcher = vi.fn<typeof fetch>();
  vi.stubGlobal('fetch', fetcher);
  const { hook, event, ctx, set } = await setupHook({ memory: true, ...limits });
  ctx.model.list.mockResolvedValue({ data: [{
    providerID: 'example', id: 'model', limit: { context: 400000, input: 272000, output: 128000 },
  }] as Awaited<ReturnType<typeof ctx.model.list>>['data'], location: { directory: '/unused' } });
  event.messages = [{ role: 'user', content: [{ type: 'text', text: 'x'.repeat(140000) }] }] as SessionCompaction['messages'];
  await hook(event);
  expect(event.result).toBeUndefined();
  expect(fetcher).not.toHaveBeenCalled();
  expect(set).toHaveBeenCalledWith('last/session-test', expect.objectContaining({
    kind: 'fallback', reason: expect.stringMatching(/^protected checkpoint /),
  }));
});

test('does not expand the default target when the model capacity is unknown', async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const { hook, event, set } = await setupHook({ memory: true });
  event.messages = [{ role: 'user', content: [{ type: 'text', text: 'x'.repeat(140000) }] }] as SessionCompaction['messages'];
  await hook(event);
  expect(event.result).toBeUndefined();
  expect(set).toHaveBeenCalledWith('last/session-test', expect.objectContaining({
    kind: 'fallback', budgetTokens: 20000,
  }));
});

test('reports the protected minimum when it exceeds the usable model capacity', async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const fetcher = vi.fn<typeof fetch>();
  vi.stubGlobal('fetch', fetcher);
  const { hook, event, ctx, set } = await setupHook({ memory: true });
  ctx.model.list.mockResolvedValue({ data: [{
    providerID: 'example', id: 'model', limit: { context: 400000, input: 40000, output: 128000 },
  }] as Awaited<ReturnType<typeof ctx.model.list>>['data'], location: { directory: '/unused' } });
  event.messages = [{ role: 'user', content: [{ type: 'text', text: 'x'.repeat(140000) }] }] as SessionCompaction['messages'];
  await hook(event);
  expect(event.result).toBeUndefined();
  expect(fetcher).not.toHaveBeenCalled();
  expect(set).toHaveBeenCalledWith('last/session-test', expect.objectContaining({
    kind: 'fallback', stats: expect.objectContaining({ protectedTokens: expect.any(Number), protectedChars: expect.any(Number) }),
  }));
});

async function setupBudgetHook(options: Record<string, unknown> = {}, input = 272000, context = 400000) {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const fetcher = vi.fn<typeof fetch>(async (_input, init) => {
    const { state, questions } = JSON.parse(String(init?.body));
    return new Response(JSON.stringify(await keepAll.ask(state, questions)));
  });
  vi.stubGlobal('fetch', fetcher);
  const fixture = await setupHook({ memory: true, ...options });
  fixture.ctx.model.list.mockResolvedValue({ data: [{
    providerID: 'example', id: 'model', limit: { context, input, output: 128000 },
  }] as Awaited<ReturnType<typeof fixture.ctx.model.list>>['data'], location: { directory: '/unused' } });
  return { ...fixture, fetcher };
}

function budgetHistory(protectedChars: number): SessionCompaction['messages'] {
  return [
    { role: 'user', content: [{ type: 'text', text: 'x'.repeat(protectedChars) }] },
    { role: 'assistant', content: [{ type: 'text', text: 'Optional old investigation. '.repeat(3000) }] },
    ...Array.from({ length: 6 }, () => ({ role: 'assistant', content: [{ type: 'text', text: 'Current protected progress.' }] })),
  ] as SessionCompaction['messages'];
}

test('reports the effective protected-floor budget without consuming the whole model capacity', async () => {
  const { hook, event, set, fetcher } = await setupBudgetHook();
  event.messages = budgetHistory(140000);
  await hook(event);
  expect(event.result?.summary).toContain('x'.repeat(140000));
  expect(event.result?.summary).not.toContain('Optional old investigation.');
  expect(fetcher).toHaveBeenCalled();
  const metadata = event.result?.metadata?.fastJevCompaction as {
    budgetTokens: number; effectiveTokens: number; effectiveChars: number; protectedTokens: number; protectedChars: number;
    estimatedTokens: number; targetTokens: number; budget: { capacityTokens: number; overheadTokens: number };
  };
  expect(metadata).toMatchObject({
    targetTokens: 20000, targetChars: 100000,
    budget: { targetTokens: 20000, targetChars: 100000, limitChars: expect.any(Number), limitTokens: expect.any(Number),
      inputWindowTokens: 272000, overheadTokens: expect.any(Number), recentReserveTokens: 20000, workingReserveTokens: 10000,
      explicitTokens: false, explicitChars: false },
  });
  expect(metadata.budgetTokens).toBe(metadata.effectiveTokens);
  expect(metadata.effectiveTokens).toBe(metadata.protectedTokens);
  expect(metadata.effectiveChars).toBe(metadata.protectedChars);
  expect(metadata.budgetTokens).toBeGreaterThan(20000);
  expect(metadata.budgetTokens).toBeLessThan(metadata.budget.capacityTokens);
  expect(metadata.estimatedTokens).toBeLessThanOrEqual(metadata.budgetTokens);
  expect(metadata.budget.capacityTokens).toBe(272000 - metadata.budget.overheadTokens - 30000);
  expect(set).toHaveBeenCalledWith('last/session-test', expect.objectContaining({
    kind: 'pruned', budgetTokens: metadata.budgetTokens, budget: metadata.budget,
    stats: expect.objectContaining({ protectedTokens: metadata.protectedTokens, protectedChars: metadata.protectedChars }),
  }));
});

test('keeps the 20k selection target when a small protected floor fits a large model', async () => {
  const { hook, event } = await setupBudgetHook();
  event.messages = budgetHistory(100);
  await hook(event);
  expect(event.result?.summary).toContain('x'.repeat(100));
  expect(event.result?.summary).not.toContain('Optional old investigation.');
  expect(event.result?.metadata?.fastJevCompaction).toMatchObject({
    budgetTokens: 20000, effectiveTokens: 20000,
    budget: { targetTokens: 20000, inputWindowTokens: 272000, explicitTokens: false, explicitChars: false },
  });
});

test.each(['empty', 'throwing', 'invalid'] as const)('keeps conservative defaults for a %s model catalogue', async (catalogue) => {
  const { hook, event, ctx, set, fetcher } = await setupBudgetHook({}, NaN, Infinity);
  if (catalogue === 'empty') ctx.model.list.mockResolvedValue({ data: [], location: { directory: '/unused' } });
  if (catalogue === 'throwing') ctx.model.list.mockRejectedValue(new Error('catalogue unavailable'));
  event.messages = budgetHistory(140000);
  await hook(event);
  expect(event.result).toBeUndefined();
  expect(fetcher).not.toHaveBeenCalled();
  expect(set).toHaveBeenCalledWith('last/session-test', expect.objectContaining({
    kind: 'fallback', budgetTokens: 20000,
    budgetSource: catalogue === 'throwing' ? 'configured target; model limit unavailable' : 'configured target; retained-tail reserve is an assumption',
    budget: expect.objectContaining({ targetTokens: 20000, targetChars: 100000, limitTokens: 20000, limitChars: 100000,
      capacityTokens: null, inputWindowTokens: null, overheadTokens: null, explicitTokens: false, explicitChars: false }),
  }));
});

test('non-finite explicit options leave the defaults soft with known capacity', async () => {
  const { hook, event } = await setupBudgetHook({ maxSummaryTokens: NaN, maxSummaryChars: Infinity });
  event.messages = budgetHistory(140000);
  await hook(event);
  expect(event.result?.summary).toContain('x'.repeat(140000));
  expect(event.result?.metadata?.fastJevCompaction).toMatchObject({
    budget: { targetTokens: 20000, targetChars: 100000, explicitTokens: false, explicitChars: false },
  });
});

test('zero usable capacity falls back before inference rather than reverting to defaults', async () => {
  const { hook, event, set, fetcher } = await setupBudgetHook({}, 1000);
  await hook(event);
  expect(event.result).toBeUndefined();
  expect(fetcher).not.toHaveBeenCalled();
  expect(set).toHaveBeenCalledWith('last/session-test', expect.objectContaining({
    kind: 'fallback', budgetTokens: 0,
    budget: expect.objectContaining({ capacityTokens: 0, targetTokens: 0, limitTokens: 0, targetChars: 0, limitChars: 0 }),
  }));
});

test('uses the selected input window rather than the larger context or another catalogue model', async () => {
  const { hook, event, ctx, set, fetcher } = await setupBudgetHook();
  const catalog = await ctx.model.list();
  ctx.model.list.mockResolvedValue({ ...catalog, data: [
    { ...catalog.data[0]!, providerID: 'other', limit: { input: 1000000, context: 1000000, output: 1000 } },
    { ...catalog.data[0]!, id: 'other', limit: { input: 1000000, context: 1000000, output: 1000 } },
    ...catalog.data,
  ] as typeof catalog.data });
  event.messages = [{ role: 'user', content: [{ type: 'text', text: 'x'.repeat(800000) }] }] as SessionCompaction['messages'];
  await hook(event);
  expect(event.result).toBeUndefined();
  expect(fetcher).not.toHaveBeenCalled();
  expect(set).toHaveBeenCalledWith('last/session-test', expect.objectContaining({
    kind: 'fallback', reason: expect.stringMatching(/^protected checkpoint /),
    budget: expect.objectContaining({ inputWindowTokens: 272000 }),
  }));
});

test.each([0, -1, NaN, Infinity])('uses a valid context window when the input window is invalid (%s)', async (input) => {
  const { hook, event } = await setupBudgetHook({}, input, 272000);
  event.messages = budgetHistory(140000);
  await hook(event);
  expect(event.result?.summary).toContain('x'.repeat(140000));
  expect(event.result?.metadata?.fastJevCompaction).toMatchObject({ budget: { inputWindowTokens: 272000 } });
});

test.each([
  { maxSummaryTokens: -1, maxSummaryChars: 100000.9 },
  { maxSummaryTokens: 20000.9, maxSummaryChars: -0.5 },
])('normalizes finite explicit limits before applying hard caps (%j)', async (options) => {
  const { hook, event, set, fetcher } = await setupBudgetHook(options);
  await hook(event);
  expect(event.result).toBeUndefined();
  expect(fetcher).not.toHaveBeenCalled();
  expect(set).toHaveBeenCalledWith('last/session-test', expect.objectContaining({
    kind: 'fallback', budget: expect.objectContaining({
      limitTokens: Math.max(0, Math.floor(options.maxSummaryTokens)),
      limitChars: Math.max(0, Math.floor(options.maxSummaryChars)), explicitTokens: true, explicitChars: true,
    }),
  }));
});

test('legacy pruning does not adapt a protected floor to a large model', async () => {
  const { hook, event, set, fetcher } = await setupBudgetHook({ memory: false });
  event.messages = budgetHistory(140000);
  await hook(event);
  expect(event.result).toBeUndefined();
  expect(fetcher).not.toHaveBeenCalled();
  expect(set).toHaveBeenCalledWith('last/session-test', expect.objectContaining({
    kind: 'fallback', budgetTokens: 20000,
    reason: expect.stringMatching(/^checkpoint /),
    budget: expect.objectContaining({ targetTokens: 20000, targetChars: 100000, limitTokens: 20000, limitChars: 100000 }),
  }));
});
