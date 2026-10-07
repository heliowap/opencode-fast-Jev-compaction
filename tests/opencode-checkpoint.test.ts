import { mkdtemp, rm } from 'node:fs/promises';
import { afterEach, expect, test } from 'vitest';

import { MemoryArchive } from '../opencode/archive.js';
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
