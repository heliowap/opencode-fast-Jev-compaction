import { estimateTokens } from '../src/state.js';

export interface CheckpointBudget {
  targetTokens: number;
  targetChars: number;
  limitTokens: number;
  limitChars: number;
}

export function fixedBudget(tokens: number, chars: number): CheckpointBudget {
  return { targetTokens: tokens, targetChars: chars, limitTokens: tokens, limitChars: chars };
}

export function capacityBudget({ capacityTokens, defaultTokens, defaultChars, explicitTokens, explicitChars }: {
  capacityTokens: number;
  defaultTokens: number;
  defaultChars: number;
  explicitTokens?: number;
  explicitChars?: number;
}): CheckpointBudget {
  const capacity = Math.max(0, capacityTokens);
  const limitTokens = explicitTokens === undefined ? capacity : Math.min(explicitTokens, capacity);
  const limitChars = explicitChars ?? 3 * capacity;
  return {
    targetTokens: Math.min(defaultTokens, limitTokens), targetChars: Math.min(defaultChars, limitChars),
    limitTokens, limitChars,
  };
}

export function effectiveBudget(budget: CheckpointBudget, protectedText: string) {
  const protectedTokens = checkpointTokens(protectedText);
  const protectedChars = protectedText.length;
  return {
    protectedTokens, protectedChars, ...budget,
    effectiveTokens: Math.min(budget.limitTokens, Math.max(budget.targetTokens, protectedTokens)),
    effectiveChars: Math.min(budget.limitChars, Math.max(budget.targetChars, protectedChars)),
    overflow: checkpointOverflow(protectedText, budget.limitTokens, budget.limitChars),
  };
}

export function checkpointTokens(text: string): number {
  return Math.max(estimateTokens(text), Math.ceil(text.length / 3));
}

export function checkpointOverflow(summary: string, tokens: number, chars: number): string | undefined {
  if (summary.length > chars) return `checkpoint ${summary.length} chars above ${chars}`;
  const estimated = checkpointTokens(summary);
  if (estimated > tokens) return `checkpoint ${estimated} estimated tokens above ${tokens}`;
  return undefined;
}
