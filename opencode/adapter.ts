import type { ContentPart, Message as AiMessage, ToolResultValue } from '@opencode/ai';

import type { Message, ToolResult } from '../src/types.js';

export type OcPart = ContentPart;
export type OcMessage = Pick<AiMessage, 'role' | 'content'>;

function fileText(file: Extract<Extract<ToolResultValue, { type: 'content' }>['value'][number], { type: 'file' }>): string {
  return `[file ${JSON.stringify({ mediaType: file.mime, filename: file.name, uri: file.uri })}]`;
}

function mediaText(part: Extract<OcPart, { type: 'media' }>): string {
  const source = part.media.source;
  return `[media ${JSON.stringify({
    mediaType: part.media.mediaType,
    filename: part.filename,
    source: source.type,
    uri: source.type === 'url' ? source.url : undefined,
    provider: source.type === 'ref' ? source.provider : undefined,
    id: source.type === 'ref' ? source.id : undefined,
    info: part.media.info,
  })}]`;
}

function resultText(result: ToolResultValue): string {
  if (result.type === 'content') {
    return result.value
      .map((item) => item.type === 'text' ? item.text : fileText(item))
      .join('\n\n');
  }
  if (typeof result.value === 'string') return result.value;
  return JSON.stringify(result.value) ?? '';
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return input !== null && typeof input === 'object' && !Array.isArray(input);
}

/** A reason to leave compaction to OpenCode rather than lose opaque context. */
export function unsupportedReason(messages: readonly OcMessage[]): string | undefined {
  for (const message of messages) {
    for (const part of message.content) {
      switch (part.type) {
        case 'compaction':
          if (part.encrypted !== undefined) return 'encrypted compaction checkpoint';
          if (typeof part.text !== 'string') return 'compaction checkpoint has no text';
          break;
        case 'reasoning':
          if (part.encrypted !== undefined) return 'encrypted reasoning';
          break;
        case 'text':
        case 'media':
        case 'tool-call':
        case 'tool-result':
        case 'effort':
          break;
        default:
          part satisfies never;
          return 'unsupported content part';
      }
    }
  }
  return undefined;
}

/**
 * Maps OpenCode's model messages onto the library's transcript. `system`
 * messages are injected updates; OpenCode re-sends its system prompt after
 * compaction. Plain reasoning is not replayed by providers. Effort changes are
 * generation settings, not conversation text.
 * Each visible part gets its own message to retain order. Pinning consequently
 * counts these segments, not the original OpenCode messages.
 */
export function fromOpenCode(messages: readonly OcMessage[]): Message[] {
  const reason = unsupportedReason(messages);
  if (reason) throw new Error(reason);
  const out: Message[] = [];
  for (const message of messages) {
    if (message.role === 'system') continue;
    const role = message.role === 'assistant' ? 'assistant' : 'user';
    for (const part of message.content) {
      switch (part.type) {
        case 'text':
          out.push({ role, text: part.text, toolUses: [] });
          break;
        case 'compaction':
          if (typeof part.text === 'string') out.push({ role, text: part.text, toolUses: [] });
          break;
        case 'media':
          out.push({ role, text: mediaText(part), toolUses: [] });
          break;
        case 'tool-call':
          out.push({ role, text: '', toolUses: [{
            tool_use_id: part.id,
            tool: part.name,
            input: isRecord(part.input) ? part.input : { value: part.input },
          }] });
          break;
        case 'tool-result': {
          const result: ToolResult = { tool_use_id: part.id, text: resultText(part.result) };
          if (part.result.type === 'error') result.isError = true;
          out.push({ role, text: '', toolUses: [], toolResults: [result] });
          break;
        }
        case 'reasoning':
        case 'effort':
          break;
        default:
          part satisfies never;
          throw new Error('unsupported content part');
      }
    }
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
