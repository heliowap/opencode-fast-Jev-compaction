import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';

import { MemoryArchive } from '../opencode/archive.js';
import { capacityBudget, fixedBudget } from '../opencode/budget.js';
import { pruneForCheckpoint, resolveConfig } from '../opencode/index.js';
import type { JevAsker } from '../src/types.js';
import { estimateTokens } from '../src/state.js';
import type { OcMessage } from '../opencode/adapter.js';
import { Media } from '@opencode/ai/media';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function memory() {
  const root = await mkdtemp('/private/tmp/opencode/jev-checkpoint-');
  roots.push(root);
  return new MemoryArchive(root);
}

const stale: JevAsker = {
  async ask(_state, questions) {
    return { answers: Object.fromEntries(Object.keys(questions).map((key) => [key, { noul: 0.1 }])) };
  },
};

test('archives stale assistant prose while preserving user constraints and exact recovery', async () => {
  const archive = await memory();
  const prose = 'Old exploration of another approach. '.repeat(1000);
  const outcome = await pruneForCheckpoint([
    { id: 'msg_user', role: 'user', content: [{ type: 'text', text: 'Fix auth. Do not edit generated files.' }] },
    { id: 'msg_old', role: 'assistant', content: [{ type: 'text', text: prose }] },
    { id: 'msg_change', role: 'user', content: [{ type: 'text', text: 'Also preserve the exact token expiration.' }] },
  ], resolveConfig({ preserveRecentMessages: 0, maxSummaryTokens: 1000 }, {}), stale, {
    archive, sessionID: 'session-one',
  });
  expect(outcome.kind).toBe('pruned');
  if (outcome.kind !== 'pruned') return;
  expect(outcome.summary).toContain('Do not edit generated files.');
  expect(outcome.summary).toContain('Also preserve the exact token expiration.');
  expect(outcome.summary).not.toContain(prose);
  expect(outcome.details).toMatchObject({
    archiveMs: expect.any(Number), prepareMs: expect.any(Number), jevMs: expect.any(Number),
    selectionMs: expect.any(Number), textsArchived: 1,
  });
  const hits = await archive.search('session-one', 'Old exploration');
  expect(hits).toHaveLength(1);
  expect((await archive.read('session-one', hits[0]!.id, 0, 8000)).text).toContain('Old exploration');
});

test('rebuilds a prior checkpoint without nesting its dump or restoring stale prose', async () => {
  const archive = await memory();
  const config = resolveConfig({ preserveRecentMessages: 0, maxSummaryTokens: 1000 }, {});
  const first = await pruneForCheckpoint([
    { id: 'msg_goal', role: 'user', content: [{ type: 'text', text: 'Fix auth. Never expose credentials.' }] },
    { id: 'msg_exploration', role: 'assistant', content: [{ type: 'text', text: 'obsolete branch '.repeat(1000) }] },
  ], config, stale, { archive, sessionID: 'session-repeat' });
  expect(first.kind).toBe('pruned');
  if (first.kind !== 'pruned') return;
  const second = await pruneForCheckpoint([
    {
      id: 'msg_checkpoint', role: 'user',
      metadata: { fastJevCompaction: { version: 1, manifestID: first.manifestID } },
      content: [{ type: 'text', text: `<conversation-checkpoint>\n<summary>\n${first.summary}\n</summary>\n</conversation-checkpoint>` }],
    },
    { id: 'msg_new', role: 'user', content: [{ type: 'text', text: 'Also do not edit the lockfile.' }] },
  ], config, stale, { archive, sessionID: 'session-repeat' });
  expect(second.kind).toBe('pruned');
  if (second.kind !== 'pruned') return;
  expect(second.summary.match(/Earlier conversation selected/g)).toHaveLength(1);
  expect(second.summary).toContain('Never expose credentials.');
  expect(second.summary).toContain('Also do not edit the lockfile.');
  expect(second.summary).not.toContain('<conversation-checkpoint>');
  expect(second.summary).not.toContain('obsolete branch');
});

test('shows Jev bounded tool evidence and replaces an old output with a recoverable pointer', async () => {
  const archive = await memory();
  let shown = '';
  const asker: JevAsker = {
    async ask(state, questions) {
      shown = JSON.stringify(state);
      return { answers: Object.fromEntries(Object.keys(questions).map((key) => [key, {
        noul: key.startsWith('call_') ? 0.9 : 0.1,
      }])) };
    },
  };
  const output = `START: test run\n${'noise\n'.repeat(500)}ERROR: expiration mismatch\n${'noise\n'.repeat(1500)}END: exit 1`;
  const outcome = await pruneForCheckpoint([
    { id: 'msg_goal', role: 'user', content: [{ type: 'text', text: 'Fix token expiration.' }] },
    { id: 'msg_call', role: 'assistant', content: [{ type: 'tool-call', id: 'call_test', name: 'shell', input: { command: 'npm test' } }] },
    { id: 'msg_output', role: 'tool', content: [{ type: 'tool-result', id: 'call_test', name: 'shell', result: { type: 'text', value: output } }] },
  ], resolveConfig({ preserveRecentMessages: 0, maxSummaryTokens: 1000 }, {}), asker, { archive, sessionID: 'session-output' });
  expect(shown).toContain('START: test run');
  expect(shown).toContain('ERROR: expiration mismatch');
  expect(shown).toContain('END: exit 1');
  expect(shown).not.toContain(output);
  expect(outcome.kind).toBe('pruned');
  if (outcome.kind !== 'pruned') return;
  expect(outcome.summary).toContain('[tool call call_test: shell]');
  expect(outcome.summary).toContain('fast_jev_memory_read');
  expect(outcome.summary).not.toContain(output);
});

test('batches evidence and questions within both Jev ceilings without hiding a candidate', async () => {
  const archive = await memory();
  let requests = 0;
  const asker: JevAsker = {
    async ask(state, questions) {
      requests++;
      expect(estimateTokens(JSON.stringify(state))).toBeLessThanOrEqual(1000);
      expect(estimateTokens(JSON.stringify({ model: 'jev-1.13-free', state, questions }))).toBeLessThanOrEqual(1800);
      for (const name of Object.keys(questions)) {
        const id = name.replace(/^(call|result)_/, '');
        expect(JSON.stringify(state)).toContain(`"id":"${id}"`);
      }
      return stale.ask(state, questions);
    },
  };
  const messages: OcMessage[] = [{ id: 'goal', role: 'user', content: [{ type: 'text', text: 'Find the regression.' }] }];
  for (let i = 0; i < 16; i++) {
    messages.push({ id: `call-${i}`, role: 'assistant', content: [{ type: 'tool-call', id: `c${i}`, name: 'shell', input: { command: `test ${i}` } }] });
    messages.push({ id: `result-${i}`, role: 'tool', content: [{ type: 'tool-result', id: `c${i}`, name: 'shell', result: { type: 'text', value: 'unrelated log line '.repeat(500) } }] });
  }
  const outcome = await pruneForCheckpoint(messages, resolveConfig({
    preserveRecentMessages: 0, maxStateTokens: 1000, maxRequestTokens: 1800,
  }, {}), asker, { archive, sessionID: 'session-batches' });
  expect(outcome.kind).toBe('pruned');
  expect(requests).toBeGreaterThan(1);
});

test('uses the remaining checkpoint budget for higher relevance prose instead of falling back', async () => {
  const archive = await memory();
  const asker: JevAsker = {
    async ask(_state, questions) {
      return { answers: Object.fromEntries(Object.keys(questions).map((key) => [key, {
        noul: key === 'text_m1' ? 0.6 : 0.95,
      }])) };
    },
  };
  const outcome = await pruneForCheckpoint([
    { id: 'goal', role: 'user', content: [{ type: 'text', text: 'Implement auth.' }] },
    { id: 'low', role: 'assistant', content: [{ type: 'text', text: 'LOW relevance '.repeat(120) }] },
    { id: 'high', role: 'assistant', content: [{ type: 'text', text: 'HIGH relevance '.repeat(120) }] },
  ], resolveConfig({ preserveRecentMessages: 0, maxSummaryTokens: 900 }, {}), asker, { archive, sessionID: 'ranked' });
  expect(outcome.kind).toBe('pruned');
  if (outcome.kind !== 'pruned') return;
  expect(outcome.summary).toContain('HIGH relevance');
  expect(outcome.summary).not.toContain('LOW relevance');
});

test('falls back without inference when protected user context alone exceeds the budget', async () => {
  const archive = await memory();
  let asked = false;
  const outcome = await pruneForCheckpoint([
    { id: 'large-user', role: 'user', content: [{ type: 'text', text: 'Important constraint. '.repeat(1000) }] },
    { id: 'old-assistant', role: 'assistant', content: [{ type: 'text', text: 'Old detail.' }] },
  ], resolveConfig({ preserveRecentMessages: 0, maxSummaryTokens: 1000 }, {}), {
    async ask(state, questions) { asked = true; return stale.ask(state, questions); },
  }, { archive, sessionID: 'floor' });
  expect(outcome.kind).toBe('fallback');
  expect(asked).toBe(false);
});

test('expands only to a large protected user floor and keeps stale prose exactly recoverable', async () => {
  const archive = await memory();
  const text = 'Important user constraint. '.repeat(5600);
  const prose = 'Obsolete assistant exploration. '.repeat(1000);
  let requests = 0;
  const outcome = await pruneForCheckpoint([
    { id: 'large-user', role: 'user', content: [{ type: 'text', text }] },
    { id: 'old-assistant', role: 'assistant', content: [{ type: 'text', text: prose }] },
  ], resolveConfig({ preserveRecentMessages: 0 }, {}), {
    async ask(state, questions) { requests++; return stale.ask(state, questions); },
  }, { archive, sessionID: 'adaptive-floor' }, {
    targetTokens: 20_000, targetChars: 100_000, limitTokens: 272_000, limitChars: 816_000,
  });
  expect(outcome.kind).toBe('pruned');
  expect(requests).toBe(1);
  if (outcome.kind !== 'pruned') return;
  expect(outcome.summary).toContain(text);
  expect(outcome.summary).not.toContain(prose);
  expect(outcome.details).toMatchObject({
    targetTokens: 20_000, targetChars: 100_000, limitTokens: 272_000, limitChars: 816_000,
    protectedChars: outcome.summary.length, effectiveChars: outcome.summary.length,
    protectedTokens: outcome.estimatedTokens, effectiveTokens: outcome.estimatedTokens,
    textsArchived: 1,
  });
  const hits = await archive.search('adaptive-floor', 'Obsolete assistant exploration');
  expect(hits).toHaveLength(1);
  let recovered = '';
  let offset: number | null = 0;
  while (offset !== null) {
    const chunk = await archive.read('adaptive-floor', hits[0]!.id, offset, 8000);
    recovered += chunk.text;
    offset = chunk.nextOffset;
  }
  expect(recovered).toContain(prose);
});

test.each([
  { capacityTokens: 272_000, explicitTokens: 20_000, limitTokens: 20_000, limitChars: 816_000 },
  { capacityTokens: 272_000, explicitChars: 100_000, limitTokens: 272_000, limitChars: 100_000 },
  { capacityTokens: 30_000, limitTokens: 30_000, limitChars: 90_000 },
  { capacityTokens: 30_000, explicitTokens: 100_000, limitTokens: 30_000, limitChars: 90_000 },
  { capacityTokens: 0, limitTokens: 0, limitChars: 0 },
  { capacityTokens: -100, limitTokens: 0, limitChars: 0 },
])('refuses protected-floor overflow before inference with hard capacity/caps %j', async ({
  capacityTokens, explicitTokens, explicitChars, limitTokens, limitChars,
}) => {
  const archive = await memory();
  let requests = 0;
  const outcome = await pruneForCheckpoint([
    { id: 'user', role: 'user', content: [{ type: 'text', text: 'Important user constraint. '.repeat(5600) }] },
    { id: 'old', role: 'assistant', content: [{ type: 'text', text: 'Old removable prose.' }] },
  ], resolveConfig({ preserveRecentMessages: 0 }, {}), {
    async ask(state, questions) { requests++; return stale.ask(state, questions); },
  }, { archive, sessionID: 'hard-floor' }, capacityBudget({
    capacityTokens, defaultTokens: 20_000, defaultChars: 100_000, explicitTokens, explicitChars,
  }));
  expect(outcome.kind).toBe('fallback');
  expect(requests).toBe(0);
  if (outcome.kind !== 'fallback') return;
  expect(outcome.reason).toMatch(/^protected checkpoint \d+ (chars|estimated tokens) above \d+$/);
  expect(outcome.details).toMatchObject({
    protectedTokens: expect.any(Number), protectedChars: expect.any(Number),
    targetTokens: Math.min(20_000, limitTokens), targetChars: Math.min(100_000, limitChars),
    limitTokens, limitChars, effectiveTokens: expect.any(Number), effectiveChars: expect.any(Number),
  });
  expect(outcome.details!.effectiveTokens).toBeLessThanOrEqual(limitTokens);
  expect(outcome.details!.effectiveChars).toBeLessThanOrEqual(limitChars);
});

test('keeps default fixed limits hard when no capacity budget is supplied', async () => {
  const archive = await memory();
  let requests = 0;
  const outcome = await pruneForCheckpoint([
    { id: 'user', role: 'user', content: [{ type: 'text', text: 'Important user constraint. '.repeat(5600) }] },
    { id: 'old', role: 'assistant', content: [{ type: 'text', text: 'Old removable prose.' }] },
  ], resolveConfig({ preserveRecentMessages: 0 }, {}), {
    async ask(state, questions) { requests++; return stale.ask(state, questions); },
  }, { archive, sessionID: 'unknown-capacity' });
  expect(outcome.kind).toBe('fallback');
  expect(requests).toBe(0);
  expect(outcome.details).toMatchObject({
    targetTokens: 20_000, targetChars: 100_000, limitTokens: 20_000, limitChars: 100_000,
    effectiveTokens: 20_000, effectiveChars: 100_000,
  });
});

test('accepts the exact protected checkpoint limits but refuses one additional character', async () => {
  const archive = await memory();
  const config = resolveConfig({ preserveRecentMessages: 0 }, {});
  const text = 'Boundary constraint. '.repeat(100);
  const messages: OcMessage[] = [{ id: 'user', role: 'user', content: [{ type: 'text', text }] }];
  const initial = await pruneForCheckpoint(messages, config, stale, { archive, sessionID: 'boundary' });
  if (initial.kind !== 'pruned') throw new Error('Initial checkpoint failed');
  const budget = fixedBudget(initial.estimatedTokens!, initial.summary.length);
  const exact = await pruneForCheckpoint(messages, config, stale, { archive, sessionID: 'boundary' }, budget);
  expect(exact.kind).toBe('pruned');
  if (exact.kind !== 'pruned') return;
  expect(exact.summary).toBe(initial.summary);
  const over = await pruneForCheckpoint([
    { id: 'user-plus-one', role: 'user', content: [{ type: 'text', text: `${text}x` }] },
    { id: 'old', role: 'assistant', content: [{ type: 'text', text: 'Removable prose.' }] },
  ], config, { async ask() { throw new Error('Overflow must precede inference'); } }, {
    archive, sessionID: 'boundary',
  }, budget);
  expect(over.kind).toBe('fallback');
  if (over.kind === 'fallback') expect(over.reason).toBe(
    `protected checkpoint ${initial.summary.length + 1} chars above ${initial.summary.length}`,
  );
  const tokenOverflow = await pruneForCheckpoint(messages, config, stale, { archive, sessionID: 'boundary' },
    fixedBudget(initial.estimatedTokens! - 1, initial.summary.length));
  expect(tokenOverflow.kind).toBe('fallback');
  if (tokenOverflow.kind === 'fallback') expect(tokenOverflow.reason).toContain('estimated tokens above');
});

test('does not expand selection targets for a small protected floor at known capacity', async () => {
  const archive = await memory();
  const outcome = await pruneForCheckpoint([
    { id: 'goal', role: 'user', content: [{ type: 'text', text: 'Implement auth.' }] },
    { id: 'low', role: 'assistant', content: [{ type: 'text', text: 'LOW relevance '.repeat(120) }] },
    { id: 'high', role: 'assistant', content: [{ type: 'text', text: 'HIGH relevance '.repeat(120) }] },
  ], resolveConfig({ preserveRecentMessages: 0, maxSummaryTokens: 900 }, {}), {
    async ask(_state, questions) {
      return { answers: Object.fromEntries(Object.keys(questions).map((key) => [key, {
        noul: key === 'text_m1' ? 0.6 : 0.95,
      }])) };
    },
  }, { archive, sessionID: 'adaptive-ranked' }, capacityBudget({
    capacityTokens: 272_000, defaultTokens: 900, defaultChars: 100_000,
  }));
  expect(outcome.kind).toBe('pruned');
  if (outcome.kind !== 'pruned') return;
  expect(outcome.summary).toContain('HIGH relevance');
  expect(outcome.summary).not.toContain('LOW relevance');
  expect(outcome.estimatedTokens).toBeLessThanOrEqual(900);
  expect(outcome.details).toMatchObject({
    targetTokens: 900, targetChars: 100_000, effectiveTokens: 900, effectiveChars: 100_000,
    limitTokens: 272_000, limitChars: 816_000,
  });
});

test('retains a large opaque native checkpoint once across repeated metadata resumes', async () => {
  const archive = await memory();
  const config = resolveConfig({ preserveRecentMessages: 0 }, {});
  const budget = capacityBudget({ capacityTokens: 272_000, defaultTokens: 20_000, defaultChars: 100_000 });
  const native = `<conversation-checkpoint>\n<summary>\n${'Original native user constraint. '.repeat(4400)}\n</summary>\n</conversation-checkpoint>`;
  const tail = '[User]: Keep the historical receipt 4931 and never edit generated files.';
  let requests = 0;
  const asker: JevAsker = {
    async ask(state, questions) { requests++; return stale.ask(state, questions); },
  };
  const first = await pruneForCheckpoint([
    { id: 'native', role: 'user', content: [{ type: 'compaction', text: native }] },
    { id: 'old', role: 'assistant', content: [{ type: 'text', text: 'Obsolete native exploration.' }] },
  ], config, asker, { archive, sessionID: 'large-native-resume' }, budget);
  expect(first.kind).toBe('pruned');
  if (first.kind !== 'pruned') return;
  const second = await pruneForCheckpoint([{
    id: 'checkpoint-one', role: 'user', metadata: { fastJevCompaction: { version: 1, manifestID: first.manifestID } },
    content: [{ type: 'text', text: `<conversation-checkpoint>\n<summary>\n${first.summary}\n</summary>\n\n<recent-context>\n${tail}\n</recent-context>\n</conversation-checkpoint>` }],
  }], config, asker, { archive, sessionID: 'large-native-resume' }, budget);
  expect(second.kind).toBe('pruned');
  if (second.kind !== 'pruned') return;
  const third = await pruneForCheckpoint([{
    id: 'checkpoint-two', role: 'user', metadata: { fastJevCompaction: { version: 1, manifestID: second.manifestID } },
    content: [{ type: 'text', text: second.summary }],
  }], config, asker, { archive, sessionID: 'large-native-resume' }, budget);
  expect(third.kind).toBe('pruned');
  if (third.kind !== 'pruned') return;
  for (const summary of [first.summary, second.summary, third.summary]) {
    expect(summary.split(native)).toHaveLength(2);
    expect(summary.match(/Earlier conversation selected/g)).toHaveLength(1);
    expect(summary).not.toContain('Obsolete native exploration.');
  }
  expect(third.summary.split(tail)).toHaveLength(2);
  expect(third.summary).toBe(second.summary);
  expect(requests).toBe(1);
  const hits = await archive.search('large-native-resume', 'Obsolete native exploration');
  expect(hits).toHaveLength(1);
  expect((await archive.read('large-native-resume', hits[0]!.id, 0, 8000)).text).toContain('Obsolete native exploration.');
});

test('reuses unchanged assessments but re-evaluates after the Jev model changes', async () => {
  const archive = await memory();
  let requests = 0;
  const asker: JevAsker = {
    async ask(_state, questions) {
      requests++;
      return { answers: Object.fromEntries(Object.keys(questions).map((key) => [key, { noul: 0.9 }])) };
    },
  };
  const config = resolveConfig({ preserveRecentMessages: 0 }, {});
  const initial = await pruneForCheckpoint([
    { id: 'goal', role: 'user', content: [{ type: 'text', text: 'Fix auth.' }] },
    { id: 'decision', role: 'assistant', content: [{ type: 'text', text: 'Keep token expiration in milliseconds.' }] },
  ], config, asker, { archive, sessionID: 'cached' });
  if (initial.kind !== 'pruned') throw new Error('Initial checkpoint failed');
  const resume = (summary: string, manifestID: string | undefined): OcMessage[] => [{
    id: 'checkpoint', role: 'user', content: [{ type: 'text', text: summary }],
    metadata: { fastJevCompaction: { version: 1, manifestID } },
  }];
  const next = await pruneForCheckpoint(resume(initial.summary, initial.manifestID), config, asker, { archive, sessionID: 'cached' });
  expect(next.kind).toBe('pruned');
  expect(requests).toBe(1);
  if (next.kind !== 'pruned') return;
  await pruneForCheckpoint(resume(next.summary, next.manifestID), { ...config, model: 'different-jev' }, asker, { archive, sessionID: 'cached' });
  expect(requests).toBe(2);
});

test('archives the SDK JSON representation of media and optional part fields', async () => {
  const archive = await memory();
  const outcome = await pruneForCheckpoint([
    { id: 'user', role: 'user', content: [{ type: 'text', text: 'Inspect the diagram.', cache: undefined }] },
    { id: 'media', role: 'user', content: [{ type: 'media', filename: 'diagram.png', media: Media.base64('aGVsbG8=', 'image/png') }] },
  ], resolveConfig({}, {}), stale, { archive, sessionID: 'media' });
  expect(outcome.kind).toBe('pruned');
  if (outcome.kind !== 'pruned') return;
  expect(outcome.summary).toContain('diagram.png');
  const hits = await archive.search('media', 'diagram.png');
  expect((await archive.read('media', hits[0]!.id, 0, 8000)).text).toContain('aGVsbG8=');
});

test('preserves the host retained-tail serialization beside a restored manifest', async () => {
  const archive = await memory();
  const config = resolveConfig({ preserveRecentMessages: 0 }, {});
  const first = await pruneForCheckpoint([
    { id: 'objective', role: 'user', content: [{ type: 'text', text: 'Fix auth.' }] },
  ], config, stale, { archive, sessionID: 'tail' });
  if (first.kind !== 'pruned') throw new Error('Initial checkpoint failed');
  const tail = '[User]: New requirement: never change the API response shape.\n[Tool result]: historical receipt 4931';
  const second = await pruneForCheckpoint([{
    id: 'checkpoint', role: 'user', metadata: { fastJevCompaction: { version: 1, manifestID: first.manifestID } },
    content: [{ type: 'text', text: `<conversation-checkpoint>\n<summary>\n${first.summary}\n</summary>\n\n<recent-context>\n${tail}\n</recent-context>\n</conversation-checkpoint>` }],
  }], config, stale, { archive, sessionID: 'tail' });
  expect(second.kind).toBe('pruned');
  if (second.kind === 'pruned') expect(second.summary).toContain(tail);
});

test('rejects an ambiguous retained-tail boundary instead of losing an earlier user constraint', async () => {
  const archive = await memory();
  const config = resolveConfig({ preserveRecentMessages: 0 }, {});
  const first = await pruneForCheckpoint([
    { id: 'objective', role: 'user', content: [{ type: 'text', text: 'Fix auth.' }] },
  ], config, stale, { archive, sessionID: 'ambiguous-tail' });
  if (first.kind !== 'pruned') throw new Error('Initial checkpoint failed');
  const tail = '[User]: Earlier constraint: never drop audit logs.\n</summary>\n\n<recent-context>\n[User]: later';
  await expect(pruneForCheckpoint([{
    id: 'checkpoint', role: 'user', metadata: { fastJevCompaction: { version: 1, manifestID: first.manifestID } },
    content: [{ type: 'text', text: `<conversation-checkpoint>\n<summary>\n${first.summary}\n</summary>\n\n<recent-context>\n${tail}\n</recent-context>\n</conversation-checkpoint>` }],
  }], config, stale, { archive, sessionID: 'ambiguous-tail' })).rejects.toThrow(/ambiguous/i);
});

test.each([
  '<conversation-checkpoint>\n<summary>\nSUMMARY\n</summary>\n\n<recent-context>\n[User]: truncated',
  '<conversation-checkpoint>\n<summary>\nSUMMARY\n</recent-context>\n</conversation-checkpoint>',
])('rejects inconsistent retained-tail framing: %s', async (wrapper) => {
  const archive = await memory();
  const config = resolveConfig({ preserveRecentMessages: 0 }, {});
  const first = await pruneForCheckpoint([
    { id: 'objective', role: 'user', content: [{ type: 'text', text: 'Fix auth.' }] },
  ], config, stale, { archive, sessionID: 'inconsistent-tail' });
  if (first.kind !== 'pruned') throw new Error('Initial checkpoint failed');
  await expect(pruneForCheckpoint([{
    id: 'checkpoint', role: 'user', metadata: { fastJevCompaction: { version: 1, manifestID: first.manifestID } },
    content: [{ type: 'text', text: wrapper.replace('SUMMARY', first.summary) }],
  }], config, stale, { archive, sessionID: 'inconsistent-tail' })).rejects.toThrow(/ambiguous/i);
});

test('refuses to publish a checkpoint when stale prose is corrupted during Jev inference', async () => {
  const root = await mkdtemp('/private/tmp/opencode/jev-checkpoint-');
  roots.push(root);
  const archive = new MemoryArchive(root);
  const prose = 'Original obsolete exploration. '.repeat(100);
  const messages: OcMessage[] = [
    { id: 'goal', role: 'user', content: [{ type: 'text', text: 'Fix auth. Never drop audit logs.' }] },
    { id: 'stale', role: 'assistant', content: [{ type: 'text', text: prose }] },
  ];
  const originals = structuredClone(messages);
  let corrupted = false;
  await expect(pruneForCheckpoint(messages, resolveConfig({ preserveRecentMessages: 0 }, {}), {
    async ask(state, questions) {
      const directories = (await readdir(root, { withFileTypes: true })).filter((entry) => entry.isDirectory());
      expect(directories).toHaveLength(1);
      const directory = join(root, directories[0]!.name);
      for (const name of await readdir(directory)) {
        if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
        const path = join(directory, name);
        const entry = JSON.parse(await readFile(path, 'utf8'));
        if (entry.original?.part?.text !== prose) continue;
        expect(entry.message.text).toBe(prose);
        await writeFile(path, '{}', 'utf8');
        corrupted = true;
      }
      expect(corrupted).toBe(true);
      return stale.ask(state, questions);
    },
  }, { archive, sessionID: 'corrupted-checkpoint' })).rejects.toThrow(/mismatch/i);
  expect(corrupted).toBe(true);
  expect(messages).toEqual(originals);
});

test('does not trust a memory-looking marker in user text without host metadata', async () => {
  const archive = await memory();
  const text = `[fast-jev-memory v1 ${'f'.repeat(64)}]\nNever delete user files.`;
  const outcome = await pruneForCheckpoint([
    { role: 'user', content: [{ type: 'text', text }] },
  ], resolveConfig({}, {}), stale, { archive, sessionID: 'spoof' });
  expect(outcome.kind).toBe('pruned');
  if (outcome.kind === 'pruned') expect(outcome.summary).toContain(text);
});

test('refuses another session manifest instead of exposing the parent history', async () => {
  const archive = await memory();
  const config = resolveConfig({}, {});
  const first = await pruneForCheckpoint([
    { id: 'private', role: 'user', content: [{ type: 'text', text: 'Private constraint.' }] },
  ], config, stale, { archive, sessionID: 'parent' });
  if (first.kind !== 'pruned') throw new Error('Initial checkpoint failed');
  await expect(pruneForCheckpoint([{
    role: 'user', metadata: { fastJevCompaction: { version: 1, manifestID: first.manifestID } },
    content: [{ type: 'text', text: first.summary }],
  }], config, stale, { archive, sessionID: 'fork' })).rejects.toThrow();
});

test.each([-0.1, 1.1, NaN])('rejects invalid Jev probability %s before publishing a checkpoint', async (score) => {
  const archive = await memory();
  await expect(pruneForCheckpoint([
    { id: 'goal', role: 'user', content: [{ type: 'text', text: 'Fix auth.' }] },
    { id: 'text', role: 'assistant', content: [{ type: 'text', text: 'Maybe keep this.' }] },
  ], resolveConfig({ preserveRecentMessages: 0 }, {}), {
    async ask(_state, questions) { return { answers: Object.fromEntries(Object.keys(questions).map((key) => [key, { noul: score }])) }; },
  }, { archive, sessionID: 'probabilities' })).rejects.toThrow(/Invalid Jev/);
});

test('gives Jev recent protected progress alongside the candidate and user goal', async () => {
  const archive = await memory();
  const outcome = await pruneForCheckpoint([
    { id: 'goal', role: 'user', content: [{ type: 'text', text: 'Continue implementing auth.' }] },
    { id: 'stale', role: 'assistant', content: [{ type: 'text', text: 'An older discarded approach.' }] },
    { id: 'progress', role: 'assistant', content: [{ type: 'text', text: 'Current step: fix the refresh-token retry path.' }] },
  ], resolveConfig({ preserveRecentMessages: 1 }, {}), {
    async ask(state, questions) {
      expect(JSON.stringify(state)).toContain('Current step: fix the refresh-token retry path.');
      return stale.ask(state, questions);
    },
  }, { archive, sessionID: 'progress' });
  expect(outcome.kind).toBe('pruned');
});
