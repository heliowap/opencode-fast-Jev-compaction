import type { Plugin } from '@opencode/plugin';

import { fromOpenCode, renderTranscript, unsupportedReason, type OcMessage } from './adapter.js';
import { JevClient } from '../src/client.js';
import { compact, reductionRatio } from '../src/compact.js';
import { DEFAULT_MODEL } from '../src/request.js';
import type { CompactOptions, CompactResult, JevAsker } from '../src/types.js';

const OPENCODE_ZEN_URL = 'https://opencode.ai/zen/v1/systemone';
const OPENCODE_ZEN_FREE_MODEL = 'jev-1.13-free';

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

function optionNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function optionString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Where Jev is reached: TypeSafe when a TypeSafe key is configured, otherwise
 * OpenCode Zen's free Jev, which needs no key (`OPENCODE_API_KEY` is sent when
 * set). The `provider` option, or `FAST_JEV_PROVIDER` for installs that take
 * no options, forces either.
 */
export function resolveConfig(options: Record<string, unknown>, env = process.env): PluginConfig {
  const typesafeKey = optionString(options.apiKey) ?? optionString(env.TYPESAFE_API_KEY);
  const forced = optionString(options.provider) ?? optionString(env.FAST_JEV_PROVIDER);
  const provider: Provider =
    forced === 'typesafe' || forced === 'opencode' ? forced : typesafeKey ? 'typesafe' : 'opencode';
  const zen = provider === 'opencode';
  const config: PluginConfig = {
    provider,
    model: optionString(options.model) ?? (zen ? OPENCODE_ZEN_FREE_MODEL : DEFAULT_MODEL),
    minReductionRatio: optionNumber(options.minReductionRatio, 0.25),
    maxSummaryChars: optionNumber(options.maxSummaryChars, 100_000),
  };
  for (const key of NUMERIC_OPTIONS) {
    const value = options[key];
    if (typeof value === 'number' && Number.isFinite(value)) config[key] = value;
  }
  const apiKey = zen ? (optionString(options.apiKey) ?? optionString(env.OPENCODE_API_KEY)) : typesafeKey;
  if (apiKey) config.apiKey = apiKey;
  const baseUrl = optionString(options.baseUrl) ?? (zen ? OPENCODE_ZEN_URL : undefined);
  if (baseUrl) config.baseUrl = baseUrl;
  return config;
}

export function describeProvider(config: PluginConfig): string {
  return `${config.model} via ${config.provider === 'opencode' ? 'OpenCode Zen' : 'TypeSafe'} (${config.apiKey ? 'key' : 'no key'})`;
}

export function jevAsker(config: PluginConfig, fetchFn: typeof fetch = fetch): JevAsker {
  const keylessZen = config.provider === 'opencode' && !config.apiKey;
  return new JevClient({
    // JevClient requires a key; this placeholder never leaves the plugin's fetch wrapper.
    apiKey: keylessZen ? 'opencode-keyless' : (config.apiKey ?? ''),
    model: config.model,
    baseUrl: config.baseUrl,
    fetch: (input, init) => {
      const headers = new Headers(init?.headers);
      if (keylessZen) headers.delete('authorization');
      const requestHeaders: Record<string, string> = {};
      headers.forEach((value, name) => {
        requestHeaders[name] = value;
      });
      return fetchFn(input, {
        ...init,
        headers: requestHeaders,
        signal: AbortSignal.timeout(60_000),
      });
    },
  });
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
  const unsupported = unsupportedReason(messages);
  if (unsupported) return { kind: 'fallback', reason: unsupported };
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

function stats(result: CompactResult | undefined): Record<string, number | string> {
  if (!result) return {};
  return { ...result.stats, reduction: Number(reductionRatio(result).toFixed(3)) };
}

type Ctx = {
  options: Plugin.Context['options'];
  session: Pick<Plugin.Context['session'], 'hook'>;
  storage: Pick<Plugin.Context['storage'], 'set'>;
};

// Plain object instead of Plugin.define so the global plugin needs no installed dependencies.
export default {
  id: 'fast-jev-compaction',
  async setup(ctx: Ctx) {
    const config = resolveConfig(ctx.options);
    const asker = jevAsker(config);
    console.log(`[fast-jev-compaction] Jev: ${describeProvider(config)}`);
    await ctx.session.hook('compaction', async (event) => {
      let outcome: Outcome;
      try {
        outcome = await pruneForCheckpoint(event.messages, config, asker);
      } catch (error) {
        outcome = { kind: 'fallback', reason: error instanceof Error ? error.message : String(error) };
      }
      try {
        await ctx.storage.set(`last/${event.sessionID}`, {
          at: new Date().toISOString(),
          kind: outcome.kind,
          reason: outcome.kind === 'fallback' ? outcome.reason : null,
          stats: stats(outcome.result),
        });
      } catch (error) {
        console.warn(
          `[fast-jev-compaction] could not persist diagnostics: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
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
} satisfies Plugin.Plugin;
