import { expect, test } from 'vitest';
import { Media } from '@opencode/ai/media';
import { ProviderID } from '@opencode/ai/schema/ids';

import { fromOpenCode, renderTranscript, unsupportedReason, type OcMessage } from '../opencode/adapter.js';
import { applyDecisions, decideCall } from '../src/compact.js';
import { collectToolCalls } from '../src/state.js';

const big = 'x'.repeat(5000);
const header = 'Earlier conversation, pruned by fast-jev-compaction instead of summarized. User and assistant text is verbatim and in order. Tool calls judged stale were removed; some tool outputs were truncated and say so. Re-run a tool when its output is needed again.';
const provider = ProviderID.make('openai');

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

test('maps tool calls and results by id and drops system messages', () => {
  const transcript = fromOpenCode(session());
  expect(transcript.length).toBe(14);
  expect(transcript[1]).toEqual({ role: 'assistant', text: '', toolUses: [{ tool_use_id: 'c1', tool: 'read', input: { path: 'f1.ts' } }] });
  expect(transcript[2]!.toolResults![0]!.tool_use_id).toBe('c1');
  expect(transcript.some((m) => m.text === 'catalog changed')).toBe(false);
});

test('renders error results', () => {
  const text = renderTranscript(
    fromOpenCode([
      { role: 'assistant', content: [{ type: 'tool-call', id: 'e', name: 'shell', input: { command: 'false' } }] },
      { role: 'tool', content: [{ type: 'tool-result', id: 'e', name: 'shell', result: { type: 'error', value: 'exit 1' } }] },
    ]),
  );
  expect(text).toBe(`${header}\n\n[tool call e: shell] {"command":"false"}\n\n[tool error e: shell]\nexit 1`);
});

test('renders interleaved text, calls, and results in their original part order', () => {
  const transcript = fromOpenCode([
    { role: 'assistant', content: [
      { type: 'text', text: 'before' },
      { type: 'tool-call', id: 'c1', name: 'read', input: { path: 'a.ts' } },
      { type: 'text', text: 'after' },
      { type: 'tool-call', id: 'c2', name: 'read', input: { path: 'b.ts' } },
      { type: 'text', text: 'last' },
    ] },
    { role: 'tool', content: [
      { type: 'tool-result', id: 'c2', name: 'read', result: { type: 'text', value: 'second output' } },
      { type: 'tool-result', id: 'c1', name: 'read', result: { type: 'text', value: 'first output' } },
    ] },
  ]);
  expect(transcript).toHaveLength(7);
  expect(renderTranscript(transcript)).toBe(
    `${header}\n\n[assistant]\nbefore\n\n[tool call c1: read] {"path":"a.ts"}\n\n[assistant]\nafter\n\n[tool call c2: read] {"path":"b.ts"}\n\n[assistant]\nlast\n\n[tool result c2: read]\nsecond output\n\n[tool result c1: read]\nfirst output`,
  );
});

test('keeps separate text parts verbatim, including whitespace and newlines', () => {
  const transcript = fromOpenCode([{ role: 'user', content: [
    { type: 'text', text: '  first\n' },
    { type: 'text', text: '\nsecond  ' },
    { type: 'text', text: '\t ' },
  ] }]);
  expect(transcript).toEqual([
    { role: 'user', text: '  first\n', toolUses: [] },
    { role: 'user', text: '\nsecond  ', toolUses: [] },
    { role: 'user', text: '\t ', toolUses: [] },
  ]);
  expect(renderTranscript(transcript)).toBe(`${header}\n\n[user]\n  first\n\n\n[user]\n\nsecond  \n\n[user]\n\t `);
});

test('dropping a split tool call also removes its result without changing text', () => {
  const transcript = fromOpenCode([
    { role: 'assistant', content: [
      { type: 'text', text: 'before' },
      { type: 'tool-call', id: 'drop', name: 'read', input: {} },
      { type: 'text', text: '\t ' },
      { type: 'tool-call', id: 'keep', name: 'read', input: {} },
      { type: 'text', text: 'after' },
    ] },
    { role: 'tool', content: [
      { type: 'tool-result', id: 'drop', name: 'read', result: { type: 'text', value: 'stale' } },
      { type: 'tool-result', id: 'keep', name: 'read', result: { type: 'text', value: 'needed' } },
    ] },
  ]);
  const calls = collectToolCalls(transcript, 0);
  expect(calls.map(({ tool_use_id, callIndex, resultIndex, pinned }) => ({ tool_use_id, callIndex, resultIndex, pinned }))).toEqual([
    { tool_use_id: 'drop', callIndex: 1, resultIndex: 5, pinned: false },
    { tool_use_id: 'keep', callIndex: 3, resultIndex: 6, pinned: false },
  ]);
  const decisions = calls.map((call) => decideCall(call, {
    keepCall: call.tool_use_id === 'drop' ? 0 : 1,
    keepResult: call.tool_use_id === 'drop' ? 0 : 1,
  }, { keepThreshold: 0.5 }));
  const pruned = applyDecisions(transcript, decisions, calls, 300);
  expect(pruned.flatMap((message) => message.toolResults ?? []).map((result) => result.tool_use_id)).toEqual(['keep']);
  expect(renderTranscript(pruned)).toBe(`${header}\n\n[assistant]\nbefore\n\n[assistant]\n\t \n\n[tool call keep: read] {}\n\n[assistant]\nafter\n\n[tool result keep: read]\nneeded`);
});

test('pins calls using split-message indices, including the result index', () => {
  const transcript = fromOpenCode([
    { role: 'assistant', content: [
      { type: 'tool-call', id: 'first', name: 'read', input: {} },
      { type: 'text', text: 'between' },
      { type: 'tool-call', id: 'recent', name: 'read', input: {} },
    ] },
    { role: 'tool', content: [
      { type: 'tool-result', id: 'first', name: 'read', result: { type: 'text', value: 'one' } },
      { type: 'tool-result', id: 'recent', name: 'read', result: { type: 'text', value: 'two' } },
    ] },
  ]);
  expect(collectToolCalls(transcript, 0).map((call) => call.pinned)).toEqual([true, false]);
  expect(collectToolCalls(transcript, 1).map((call) => call.pinned)).toEqual([true, true]);
});

test('rejects encrypted compaction checkpoints instead of silently losing context', () => {
  const messages: OcMessage[] = [{ role: 'assistant', content: [{ type: 'compaction', provider, encrypted: 'opaque checkpoint' }] }];
  expect(unsupportedReason(messages)).toBe('encrypted compaction checkpoint');
  expect(() => fromOpenCode(messages)).toThrow('encrypted compaction checkpoint');
});

test('rejects a failed provider checkpoint with null text', () => {
  const messages: OcMessage[] = [{ role: 'assistant', content: [{ type: 'compaction', provider, text: null }] }];
  expect(unsupportedReason(messages)).toBe('compaction checkpoint has no text');
  expect(() => fromOpenCode(messages)).toThrow('compaction checkpoint has no text');
});

test('preserves a text checkpoint verbatim at its original position', () => {
  const messages: OcMessage[] = [{ role: 'assistant', content: [
    { type: 'text', text: 'before' },
    { type: 'compaction', provider, text: '\n Previous checkpoint.  \n' },
    { type: 'text', text: 'after' },
  ] }];
  expect(unsupportedReason(messages)).toBeUndefined();
  expect(renderTranscript(fromOpenCode(messages))).toBe(`${header}\n\n[assistant]\nbefore\n\n[assistant]\n\n Previous checkpoint.  \n\n\n[assistant]\nafter`);
});

test('preserves an existing conversation-checkpoint user message verbatim', () => {
  expect(renderTranscript(fromOpenCode([{ role: 'user', content: [{
    type: 'text', text: '<conversation-checkpoint>\n<summary>previous</summary>\n</conversation-checkpoint>',
  }] }]))).toBe(`${header}\n\n[user]\n<conversation-checkpoint>\n<summary>previous</summary>\n</conversation-checkpoint>`);
});

test('describes URL media with its media type, filename, and URI', () => {
  const messages: OcMessage[] = [{ role: 'user', content: [{
    type: 'media', filename: 'diagram.png', media: Media.url('https://example.com/diagram.png', { mediaType: 'image/png' }),
  }] }];
  expect(unsupportedReason(messages)).toBeUndefined();
  expect(renderTranscript(fromOpenCode(messages))).toBe(`${header}\n\n[user]\n[media {"mediaType":"image/png","filename":"diagram.png","source":"url","uri":"https://example.com/diagram.png"}]`);
});

test('describes inline media without inventing a filename or URI', () => {
  expect(renderTranscript(fromOpenCode([{ role: 'user', content: [{
    type: 'media', media: Media.base64('aGVsbG8=', 'image/png'),
  }] }]))).toBe(`${header}\n\n[user]\n[media {"mediaType":"image/png","source":"base64"}]`);
});

test('describes provider media references without treating them as URLs', () => {
  expect(renderTranscript(fromOpenCode([{ role: 'user', content: [{
    type: 'media', filename: 'report.pdf', media: Media.ref(provider, 'file-123', 'application/pdf'),
  }] }]))).toBe(`${header}\n\n[user]\n[media {"mediaType":"application/pdf","filename":"report.pdf","source":"ref","provider":"openai","id":"file-123"}]`);
});

test('preserves text and file details in content tool results', () => {
  expect(renderTranscript(fromOpenCode([
    { role: 'assistant', content: [{ type: 'tool-call', id: 'f', name: 'download', input: {} }] },
    { role: 'tool', content: [{ type: 'tool-result', id: 'f', name: 'download', result: { type: 'content', value: [
      { type: 'text', text: ' saved\n' },
      { type: 'file', uri: 'file:///report.pdf', mime: 'application/pdf', name: 'report.pdf' },
      { type: 'text', text: '\nready ' },
    ] } }] },
  ]))).toBe(`${header}\n\n[tool call f: download] {}\n\n[tool result f: download]\n saved\n\n\n[file {"mediaType":"application/pdf","filename":"report.pdf","uri":"file:///report.pdf"}]\n\n\nready `);
});

test('drops plain reasoning, effort settings, and injected system updates', () => {
  const messages: OcMessage[] = [
    { role: 'system', content: [{ type: 'text', text: 'catalog changed' }] },
    { role: 'assistant', content: [
      { type: 'reasoning', text: 'private reasoning' },
      { type: 'effort' },
      { type: 'text', text: 'visible answer' },
    ] },
  ];
  expect(unsupportedReason(messages)).toBeUndefined();
  expect(renderTranscript(fromOpenCode(messages))).toBe(`${header}\n\n[assistant]\nvisible answer`);
});

test('rejects encrypted reasoning rather than losing provider state', () => {
  const messages: OcMessage[] = [{ role: 'assistant', content: [{ type: 'reasoning', text: '', encrypted: 'opaque state' }] }];
  expect(unsupportedReason(messages)).toBe('encrypted reasoning');
  expect(() => fromOpenCode(messages)).toThrow('encrypted reasoning');
});

test('rejects unknown runtime part types from a newer SDK', () => {
  const part = { type: 'text', text: 'future content' } satisfies import('../opencode/adapter.js').OcPart;
  Reflect.set(part, 'type', 'future-part');
  const messages: OcMessage[] = [{ role: 'assistant', content: [part] }];
  expect(unsupportedReason(messages)).toBe('unsupported content part');
  expect(() => fromOpenCode(messages)).toThrow('unsupported content part');
});

test('accepts an empty text checkpoint rather than mistaking it for provider failure', () => {
  const messages: OcMessage[] = [{ role: 'assistant', content: [{ type: 'compaction', provider, text: '' }] }];
  expect(unsupportedReason(messages)).toBeUndefined();
  expect(fromOpenCode(messages)).toEqual([{ role: 'assistant', text: '', toolUses: [] }]);
  expect(renderTranscript(fromOpenCode(messages))).toBe(header);
});

test('renders JSON tool results without losing their structure', () => {
  expect(renderTranscript(fromOpenCode([
    { role: 'assistant', content: [{ type: 'tool-call', id: 'j', name: 'list', input: {} }] },
    { role: 'tool', content: [{ type: 'tool-result', id: 'j', name: 'list', result: { type: 'json', value: { files: ['a.ts'], count: 1 } } }] },
  ]))).toBe(`${header}\n\n[tool call j: list] {}\n\n[tool result j: list]\n{"files":["a.ts"],"count":1}`);
});

test('renders structured error results as errors', () => {
  expect(renderTranscript(fromOpenCode([
    { role: 'assistant', content: [{ type: 'tool-call', id: 'e', name: 'shell', input: ['false'] }] },
    { role: 'tool', content: [{ type: 'tool-result', id: 'e', name: 'shell', result: { type: 'error', value: { code: 1, message: 'failed' } } }] },
  ]))).toBe(`${header}\n\n[tool call e: shell] {"value":["false"]}\n\n[tool error e: shell]\n{"code":1,"message":"failed"}`);
});
