import { expect, test } from 'vitest';

import { fromOpenCode, renderTranscript, type OcMessage } from '../opencode/adapter.js';

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
  expect(text).toContain('[tool error e: shell]\nexit 1');
});
