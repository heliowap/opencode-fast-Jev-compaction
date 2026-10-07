import { estimateTokens } from '../src/state.js';

export function checkpointTokens(text: string): number {
  return Math.max(estimateTokens(text), Math.ceil(text.length / 3));
}

export function checkpointOverflow(summary: string, tokens: number, chars: number): string | undefined {
  if (summary.length > chars) return `checkpoint ${summary.length} chars above ${chars}`;
  const estimated = checkpointTokens(summary);
  if (estimated > tokens) return `checkpoint ${estimated} estimated tokens above ${tokens}`;
  return undefined;
}
