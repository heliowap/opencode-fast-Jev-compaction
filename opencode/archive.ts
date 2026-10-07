import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, mkdir, open, opendir, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import type { Message } from '../src/types.js';

export interface ArchiveInput {
  source: string;
  message: Message;
  original: unknown;
}

export interface ArchiveEntry extends ArchiveInput {
  id: string;
}

export interface ArchiveManifest {
  version: 1;
  entries: {
    id: string;
    mode: 'full' | 'preview' | 'off';
    callScore?: number;
    resultScore?: number;
    textScore?: number;
  }[];
  task: string;
}

function digest(sessionID: string, text: string): string {
  return createHash('sha256').update(JSON.stringify([sessionID, text])).digest('hex');
}

function validateID(id: unknown): asserts id is string {
  if (typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)) throw new Error('Invalid archive ID');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validateInput(value: unknown): asserts value is ArchiveInput {
  if (!isRecord(value) || typeof value.source !== 'string' || !Object.hasOwn(value, 'original')
    || !isRecord(value.message)) throw new Error('Invalid archive entry');
  const message = value.message;
  if ((message.role !== 'user' && message.role !== 'assistant') || typeof message.text !== 'string'
    || !Array.isArray(message.toolUses)) throw new Error('Invalid archive message');
  for (const use of message.toolUses) {
    if (!isRecord(use) || typeof use.tool_use_id !== 'string' || typeof use.tool !== 'string'
      || !isRecord(use.input) || (use.text !== undefined && typeof use.text !== 'string')
      || (use.isError !== undefined && typeof use.isError !== 'boolean')) throw new Error('Invalid archive tool call');
  }
  if (message.toolResults !== undefined) {
    if (!Array.isArray(message.toolResults)) throw new Error('Invalid archive tool results');
    for (const result of message.toolResults) {
      if (!isRecord(result) || typeof result.tool_use_id !== 'string' || typeof result.text !== 'string'
        || (result.isError !== undefined && typeof result.isError !== 'boolean')) throw new Error('Invalid archive tool result');
    }
  }
}

function validateManifest(value: unknown): asserts value is ArchiveManifest {
  if (!isRecord(value) || value.version !== 1 || typeof value.task !== 'string' || !Array.isArray(value.entries)) {
    throw new Error('Invalid archive manifest');
  }
  const ids = new Set<string>();
  for (const entry of value.entries) {
    if (!isRecord(entry) || (entry.mode !== 'full' && entry.mode !== 'preview' && entry.mode !== 'off')) {
      throw new Error('Invalid archive manifest entry');
    }
    validateID(entry.id);
    if (ids.has(entry.id)) throw new Error('Duplicate archive ID');
    ids.add(entry.id);
    for (const name of ['callScore', 'resultScore', 'textScore']) {
      const score = entry[name];
      if (score !== undefined && (typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > 1)) {
        throw new Error('Invalid archive score');
      }
    }
  }
}

function serialize(value: unknown, omitUndefined = false, ancestors = new Set<object>()): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (typeof value !== 'object' || value === null || ancestors.has(value)) throw new Error('Invalid archive JSON');
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${Array.from(value, (item) => serialize(item, omitUndefined, ancestors)).join(',')}]`;
    }
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
      throw new Error('Invalid archive JSON object');
    }
    const object = value as Record<string, unknown>;
    const keys = Object.keys(object).filter((key) => !omitUndefined || object[key] !== undefined).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${serialize(object[key], omitUndefined, ancestors)}`).join(',')}}`;
  } finally {
    ancestors.delete(value);
  }
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

async function checkDirectory(path: string, create: boolean, privateMode = false): Promise<void> {
  if (create) {
    try {
      await mkdir(path, { mode: 0o700 });
    } catch (error) {
      if (!hasCode(error, 'EEXIST')) throw error;
    }
  }
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Unsafe archive directory');
  const file = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const opened = await file.stat();
    if (!opened.isDirectory() || opened.ino !== info.ino || opened.dev !== info.dev) {
      throw new Error('Unsafe archive directory');
    }
    if (privateMode && (opened.mode & 0o7777) !== 0o700) await file.chmod(0o700);
  } finally {
    await file.close();
  }
}

async function readSafe(path: string, expected?: string): Promise<string> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('Unsafe archive file');
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = await file.stat();
    if (!opened.isFile() || opened.ino !== info.ino || opened.dev !== info.dev) throw new Error('Unsafe archive file');
    const text = await file.readFile('utf8');
    if (expected !== undefined && text !== expected) throw new Error('Archive content mismatch');
    if ((opened.mode & 0o7777) !== 0o600) await file.chmod(0o600);
    return text;
  } finally {
    await file.close();
  }
}

async function syncDirectory(path: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Unsafe archive directory');
  const file = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const opened = await file.stat();
    if (!opened.isDirectory() || opened.ino !== info.ino || opened.dev !== info.dev) {
      throw new Error('Unsafe archive directory');
    }
    await file.sync();
  } finally {
    await file.close();
  }
}

function render(entry: ArchiveInput): string {
  const { message } = entry;
  const blocks = [`[${message.role}]\n${message.text}`];
  for (const use of message.toolUses) {
    blocks.push(`[tool call ${use.tool_use_id}: ${use.tool}] ${JSON.stringify(use)}`);
  }
  for (const result of message.toolResults ?? []) {
    blocks.push(`[tool ${result.isError ? 'error' : 'result'} ${result.tool_use_id}]\n${result.text}`);
  }
  blocks.push(`[original]\n${JSON.stringify(entry.original, null, 2)}`);
  return blocks.join('\n\n');
}

function boundedInteger(value: number, fallback: number, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || Number.isNaN(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.floor(value)));
}

async function mapConcurrent<T, U>(items: readonly T[], operation: (item: T) => Promise<U>): Promise<U[]> {
  const results: U[] = [];
  for (let index = 0; index < items.length; index += 8) {
    const batch = await Promise.allSettled(items.slice(index, index + 8).map(operation));
    for (const result of batch) {
      if (result.status === 'rejected') throw result.reason;
      results.push(result.value);
    }
  }
  return results;
}

async function publish(path: string, text: string): Promise<boolean> {
  try {
    await readSafe(path, text);
    return false;
  } catch (error) {
    if (!hasCode(error, 'ENOENT')) throw error;
  }
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, 'wx', 0o600);
  try {
    await file.chmod(0o600);
    await file.writeFile(text, 'utf8');
    await file.sync();
    await file.close();
    try {
      await link(temporary, path);
      return true;
    } catch (error) {
      if (!hasCode(error, 'EEXIST')) throw error;
      await readSafe(path, text);
      return false;
    }
  } finally {
    await file.close();
    await unlink(temporary);
  }
}

export class MemoryArchive {
  private readonly root: string;
  private readonly sessions = new Map<string, { priorOff: Set<string>; examined: Set<string> }>();

  constructor(root: string) {
    this.root = resolve(root);
  }

  private tracking(sessionID: string): { priorOff: Set<string>; examined: Set<string> } {
    let state = this.sessions.get(sessionID);
    if (!state) {
      state = { priorOff: new Set(), examined: new Set() };
      this.sessions.set(sessionID, state);
    }
    return state;
  }

  private async directory(sessionID: string, create = false): Promise<string> {
    if (typeof sessionID !== 'string') throw new Error('Invalid archive session');
    const parents: string[] = [];
    for (let path = this.root; dirname(path) !== path; path = dirname(path)) parents.unshift(path);
    for (const parent of parents) await checkDirectory(parent, create, parent === this.root);
    if (await publish(join(this.root, '.gitignore'), '*\n')) await syncDirectory(this.root);
    const session = join(this.root, digest(sessionID, 'session'));
    await checkDirectory(session, create, true);
    return session;
  }

  async put(sessionID: string, inputs: readonly ArchiveInput[]): Promise<ArchiveEntry[]> {
    const serialized = inputs.map((input) => {
      validateInput(input);
      serialize(input.original);
      return serialize(input, true);
    });
    const directory = await this.directory(sessionID, true);
    const entries = await mapConcurrent(serialized, async (text) => {
      const id = digest(sessionID, text);
      const entry: ArchiveEntry = { ...JSON.parse(text), id };
      const searchable = { id, text: render(entry) };
      await publish(join(directory, `${id}.text.json`), serialize({ ...searchable, hash: digest(sessionID, serialize(searchable)) }));
      await publish(join(directory, `${id}.json`), text);
      return entry;
    });
    await syncDirectory(directory);
    await syncDirectory(this.root);
    const state = this.tracking(sessionID);
    for (const entry of entries) state.examined.add(entry.id);
    return entries;
  }

  async get(sessionID: string, id: string): Promise<ArchiveEntry> {
    validateID(id);
    const directory = await this.directory(sessionID);
    this.tracking(sessionID).examined.add(id);
    return this.getInDirectory(sessionID, directory, id);
  }

  private async getInDirectory(sessionID: string, directory: string, id: string): Promise<ArchiveEntry> {
    validateID(id);
    const text = await readSafe(join(directory, `${id}.json`));
    if (digest(sessionID, text) !== id) throw new Error('Archive content mismatch');
    const input: unknown = JSON.parse(text);
    validateInput(input);
    return { ...input, id };
  }

  private async verifyEntries(
    sessionID: string,
    directory: string,
    manifest: ArchiveManifest,
    verifyOff: (id: string) => boolean = () => true,
  ): Promise<void> {
    await mapConcurrent(manifest.entries, async (entry) => {
      if (entry.mode !== 'off' || verifyOff(entry.id)) {
        await this.getInDirectory(sessionID, directory, entry.id);
      } else {
        const info = await lstat(join(directory, `${entry.id}.json`));
        if (!info.isFile() || info.isSymbolicLink()) throw new Error('Unsafe archive file');
      }
    });
  }

  async commit(sessionID: string, manifest: ArchiveManifest): Promise<string> {
    validateManifest(manifest);
    const text = serialize(manifest, true);
    const snapshot: ArchiveManifest = JSON.parse(text);
    const directory = await this.directory(sessionID, true);
    const state = this.sessions.get(sessionID);
    await this.verifyEntries(sessionID, directory, snapshot,
      (id) => !state?.priorOff.has(id) || state.examined.has(id));
    const id = digest(sessionID, text);
    await publish(join(directory, `${id}.manifest.json`), text);
    await syncDirectory(directory);
    await syncDirectory(this.root);
    const committed = this.tracking(sessionID);
    committed.priorOff = new Set(snapshot.entries.filter((entry) => entry.mode === 'off').map((entry) => entry.id));
    committed.examined.clear();
    return id;
  }

  async restore(sessionID: string, manifestID: string): Promise<ArchiveManifest> {
    validateID(manifestID);
    const directory = await this.directory(sessionID);
    const text = await readSafe(join(directory, `${manifestID}.manifest.json`));
    if (digest(sessionID, text) !== manifestID) throw new Error('Archive manifest content mismatch');
    const manifest: unknown = JSON.parse(text);
    validateManifest(manifest);
    await this.verifyEntries(sessionID, directory, manifest, () => false);
    this.tracking(sessionID).priorOff = new Set(manifest.entries.filter((entry) => entry.mode === 'off').map((entry) => entry.id));
    return manifest;
  }

  async read(sessionID: string, id: string, offset = 0, limit = 4000): Promise<{
    id: string;
    text: string;
    offset: number;
    nextOffset: number | null;
  }> {
    const text = render(await this.get(sessionID, id));
    const start = boundedInteger(offset, 0, 0, text.length);
    const end = Math.min(text.length, start + boundedInteger(limit, 4000, 1, 8000));
    return { id, text: text.slice(start, end), offset: start, nextOffset: end < text.length ? end : null };
  }

  /** Linear text scan; only matches load originals. Queries are capped at 4096 characters and 64 words. */
  async search(sessionID: string, query: string, limit = 10): Promise<{ id: string; excerpt: string }[]> {
    if (typeof query !== 'string' || query.length > 4096) throw new Error('Invalid archive query');
    const words = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
    if (words.length > 64) throw new Error('Invalid archive query');
    const count = boundedInteger(limit, 10, 0, 10);
    if (!words.length || !count) return [];
    let directory: string;
    let files: Awaited<ReturnType<typeof opendir>>;
    try {
      directory = await this.directory(sessionID);
      files = await opendir(directory);
    } catch (error) {
      if (hasCode(error, 'ENOENT')) return [];
      throw error;
    }
    const results: { id: string; excerpt: string }[] = [];
    for await (const { name } of files) {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
      const id = name.slice(0, 64);
      const metadata: unknown = JSON.parse(await readSafe(join(directory, `${id}.text.json`)));
      if (!isRecord(metadata) || typeof metadata.id !== 'string' || typeof metadata.text !== 'string'
        || typeof metadata.hash !== 'string') throw new Error('Invalid archive search metadata');
      if (metadata.id !== id || metadata.hash !== digest(sessionID, serialize({ id, text: metadata.text }))) {
        throw new Error('Archive search content mismatch');
      }
      const lower = metadata.text.toLowerCase();
      if (!words.every((word) => lower.includes(word))) continue;
      const text = render(await this.getInDirectory(sessionID, directory, id));
      if (text !== metadata.text) throw new Error('Archive search content mismatch');
      const start = Math.max(0, Math.min(...words.map((word) => lower.indexOf(word))) - 100);
      results.push({ id, excerpt: text.slice(start, start + 500) });
      if (results.length === count) break;
    }
    return results;
  }
}
