import type { Message, ToolResult, ToolUse } from '../src/types.js';

/** The subset of `@opencode/ai` messages the compaction hook hands over. */
export type OcPart =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'tool-call'; id: string; name: string; input: unknown }
  | { type: 'tool-result'; id: string; name: string; result: { type: string; value: unknown } }
  | { type: 'compaction'; text?: string | null }
  | { type: string; [key: string]: unknown };

export interface OcMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: readonly OcPart[];
}

function resultText(result: { type: string; value: unknown }): string {
  if (result.type === 'content' && Array.isArray(result.value)) {
    return result.value
      .map((item: { type?: string; text?: string; uri?: string; mime?: string }) =>
        item.type === 'text' ? (item.text ?? '') : `[file ${item.uri ?? ''} ${item.mime ?? ''}]`,
      )
      .join('\n');
  }
  if (typeof result.value === 'string') return result.value;
  return JSON.stringify(result.value) ?? '';
}

function toInput(input: unknown): Record<string, unknown> {
  return input !== null && typeof input === 'object' && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : { value: input };
}

function partText(part: OcPart): string | undefined {
  switch (part.type) {
    case 'text':
      return (part as { text: string }).text;
    case 'compaction':
      return (part as { text?: string | null }).text ?? undefined;
    case 'media':
    case 'file':
      return '[attachment]';
    default:
      return undefined;
  }
}

/**
 * Maps OpenCode's model messages onto the library's transcript. `system`
 * messages (catalog updates, reminders) are left out: OpenCode re-sends its
 * system prompt after compaction, so they never belong in the checkpoint.
 * Reasoning is left out too; it is provider-encrypted or not replayable.
 */
export function fromOpenCode(messages: readonly OcMessage[]): Message[] {
  const out: Message[] = [];
  for (const message of messages) {
    if (message.role === 'system') continue;
    const texts: string[] = [];
    const toolUses: ToolUse[] = [];
    const toolResults: ToolResult[] = [];
    for (const part of message.content) {
      if (part.type === 'tool-call') {
        const call = part as Extract<OcPart, { type: 'tool-call' }>;
        toolUses.push({ tool_use_id: call.id, tool: call.name, input: toInput(call.input) });
      } else if (part.type === 'tool-result') {
        const result = part as Extract<OcPart, { type: 'tool-result' }>;
        const entry: ToolResult = { tool_use_id: result.id, text: resultText(result.result) };
        if (result.result.type === 'error') entry.isError = true;
        toolResults.push(entry);
      } else {
        const text = partText(part);
        if (text) texts.push(text);
      }
    }
    const role = message.role === 'assistant' ? 'assistant' : 'user';
    const converted: Message = { role, text: texts.join('\n'), toolUses };
    if (toolResults.length > 0) converted.toolResults = toolResults;
    if (converted.text || toolUses.length > 0 || toolResults.length > 0) out.push(converted);
  }
  return out;
}

const HEADER =
  'Earlier conversation, pruned by fast-jev-compaction instead of summarized. User and assistant text is verbatim and in order. Tool calls judged stale were removed; some tool outputs were truncated and say so. Re-run a tool when its output is needed again.';

/** Renders the pruned transcript as the checkpoint text OpenCode stores as the summary. */
export function renderTranscript(messages: readonly Message[]): string {
  const names = new Map<string, string>();
  for (const message of messages) for (const use of message.toolUses) names.set(use.tool_use_id, use.tool);
  const blocks: string[] = [HEADER];
  for (const message of messages) {
    if (message.text) blocks.push(`[${message.role}]\n${message.text}`);
    for (const use of message.toolUses) {
      blocks.push(`[tool call ${use.tool_use_id}: ${use.tool}] ${JSON.stringify(use.input)}`);
    }
    for (const result of message.toolResults ?? []) {
      const name = names.get(result.tool_use_id) ?? 'tool';
      const label = result.isError ? 'tool error' : 'tool result';
      blocks.push(`[${label} ${result.tool_use_id}: ${name}]\n${result.text}`);
    }
  }
  return blocks.join('\n\n');
}
