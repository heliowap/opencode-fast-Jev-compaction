import type { Plugin } from '@opencode/plugin';

import { fromOpenCode, renderTranscript, type OcMessage } from './adapter.js';
import { compact, reductionRatio } from '../src/compact.js';
import {
  buildJevRequest,
  DEFAULT_MODEL,
  OPENCODE_ZEN_FREE_MODEL,
  OPENCODE_ZEN_URL,
  parseJevResponse,
} from '../src/request.js';
import type { CompactOptions, CompactResult, JevAsker } from '../src/types.js';

const NUMERIC_OPTIONS = [
  'keepThreshold',
  'preserveRecentMessages',
  'maxStateTokens',
  'maxRequestTokens',
  'truncateHeadChars',
] as const;

export type Provider = 'typesafe' | 'opencode';

export interface PluginConfig extends CompactOptions {
  provider: Provider;
  apiKey?: string;
  model: string;
  baseUrl?: string;
  minReductionRatio: number;
  maxSummaryChars: number;
}

function num(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Where Jev is reached: TypeSafe when a TypeSafe key is configured, otherwise
 * OpenCode Zen's free Jev, which needs no key (`OPENCODE_API_KEY` is sent when
 * set). The `provider` option, or `FAST_JEV_PROVIDER` for installs that take
 * no options, forces either.
 */
export function resolveConfig(options: Record<string, unknown>, env = process.env): PluginConfig {
  const typesafeKey = str(options.apiKey) ?? str(env.TYPESAFE_API_KEY);
  const forced = str(options.provider) ?? str(env.FAST_JEV_PROVIDER);
  const provider: Provider =
    forced === 'typesafe' || forced === 'opencode' ? forced : typesafeKey ? 'typesafe' : 'opencode';
  const zen = provider === 'opencode';
  const config: PluginConfig = {
    provider,
    model: str(options.model) ?? (zen ? OPENCODE_ZEN_FREE_MODEL : DEFAULT_MODEL),
    minReductionRatio: num(options.minReductionRatio, 0.25),
    maxSummaryChars: num(options.maxSummaryChars, 100_000),
  };
  for (const key of NUMERIC_OPTIONS) {
    if (typeof options[key] === 'number') config[key] = num(options[key], 0);
  }
  const apiKey = zen ? (str(options.apiKey) ?? str(env.OPENCODE_API_KEY)) : typesafeKey;
  if (apiKey) config.apiKey = apiKey;
  const baseUrl = str(options.baseUrl) ?? (zen ? OPENCODE_ZEN_URL : undefined);
  if (baseUrl) config.baseUrl = baseUrl;
  return config;
}

export function describeProvider(config: PluginConfig): string {
  return `${config.model} via ${config.provider === 'opencode' ? 'OpenCode Zen' : 'TypeSafe'} (${config.apiKey ? 'key' : 'no key'})`;
}

export function jevAsker(config: PluginConfig, fetchFn: typeof fetch = fetch): JevAsker {
  return {
    async ask(state, questions) {
      const request = buildJevRequest(
        { apiKey: config.apiKey ?? '', model: config.model, baseUrl: config.baseUrl },
        state,
        questions,
      );
      const response = await fetchFn(request.url, {
        method: request.method,
        headers: request.headers,
        body: request.body,
        signal: AbortSignal.timeout(60_000),
      });
      return parseJevResponse(response.status, response.ok, await response.text());
    },
  };
}

export type Outcome =
  | { kind: 'pruned'; summary: string; result: CompactResult }
  | { kind: 'fallback'; reason: string; result?: CompactResult };

/** Decides whether the pruned transcript replaces OpenCode's own summary. */
export async function pruneForCheckpoint(
  messages: readonly OcMessage[],
  config: PluginConfig,
  asker: JevAsker,
): Promise<Outcome> {
  if (config.provider === 'typesafe' && !config.apiKey) {
    return { kind: 'fallback', reason: 'TYPESAFE_API_KEY is not configured' };
  }
  const transcript = fromOpenCode(messages);
  const result = await compact(transcript, asker, config);
  const ratio = reductionRatio(result);
  if (ratio < config.minReductionRatio) {
    return {
      kind: 'fallback',
      reason: `reduction ${Math.round(ratio * 100)}% below ${Math.round(config.minReductionRatio * 100)}%`,
      result,
    };
  }
  const summary = renderTranscript(result.messages);
  // A previous checkpoint comes back as the pinned first message and text is never pruned,
  // so checkpoints only grow; past the cap the built-in summary resets them.
  if (summary.length > config.maxSummaryChars) {
    return {
      kind: 'fallback',
      reason: `checkpoint ${summary.length} chars above ${config.maxSummaryChars}`,
      result,
    };
  }
  return { kind: 'pruned', summary, result };
}

function stats(result: CompactResult | undefined): Record<string, unknown> {
  if (!result) return {};
  return { ...result.stats, reduction: Number(reductionRatio(result).toFixed(3)) };
}

type Ctx = Parameters<typeof Plugin.define>[0] extends { setup(ctx: infer C): unknown } ? C : never;

// Plain object instead of Plugin.define so the global plugin needs no installed dependencies.
export default {
  id: 'fast-jev-compaction',
  async setup(ctx: Ctx) {
    const config = resolveConfig(ctx.options as Record<string, unknown>);
    const asker = jevAsker(config);
    console.log(`[fast-jev-compaction] Jev: ${describeProvider(config)}`);
    await ctx.session.hook('compaction', async (event) => {
      let outcome: Outcome;
      try {
        outcome = await pruneForCheckpoint(event.messages as unknown as OcMessage[], config, asker);
      } catch (error) {
        outcome = { kind: 'fallback', reason: error instanceof Error ? error.message : String(error) };
      }
      await ctx.storage.set(`last/${event.sessionID}`, {
        at: new Date().toISOString(),
        kind: outcome.kind,
        reason: outcome.kind === 'fallback' ? outcome.reason : null,
        stats: stats(outcome.result),
      } as never);
      if (outcome.kind === 'fallback') {
        console.warn(`[fast-jev-compaction] fallback to built-in summary: ${outcome.reason}`);
        return;
      }
      event.result = {
        summary: outcome.summary,
        metadata: { fastJevCompaction: stats(outcome.result) },
      };
    });
  },
};
