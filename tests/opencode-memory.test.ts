import { chmod, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { afterEach, expect, test } from 'vitest';

import { MemoryArchive, type ArchiveInput, type ArchiveManifest } from '../opencode/archive.js';

const fixtures: string[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture(): Promise<string> {
  const path = await mkdtemp('/private/tmp/opencode/jev-memory-test-');
  fixtures.push(path);
  return join(path, '.jev-memory');
}

async function storedFile(root: string, name: string): Promise<string> {
  const [session] = (await readdir(root)).filter((name) => name !== '.gitignore');
  return join(root, session, name);
}

function input(text: string): ArchiveInput {
  return {
    source: 'message-1/part-0',
    message: { role: 'user', text, toolUses: [] },
    original: { type: 'text', text },
  };
}

test('recovers complete original entries after reopening the archive', async () => {
  const root = await fixture();
  const original = input('Keep the original text.\n  Whitespace matters.');
  const [entry] = await new MemoryArchive(root).put('session-one', [original]);
  expect(entry.id).toMatch(/^[a-f0-9]{64}$/);
  expect(await new MemoryArchive(root).get('session-one', entry.id)).toEqual({ ...original, id: entry.id });
});

test('deduplicates concurrent equivalent JSON entries without sharing IDs across sessions', async () => {
  const archive = new MemoryArchive(await fixture());
  const first = input('original');
  first.original = { count: 1, files: ['a.ts'] };
  const reordered = { original: { files: ['a.ts'], count: 1 }, message: first.message, source: first.source };
  const [[a], [b], [other]] = await Promise.all([
    archive.put('one', [first]),
    archive.put('one', [reordered]),
    archive.put('two', [first]),
  ]);
  expect(a.id).toBe(b.id);
  expect(other.id).not.toBe(a.id);
  expect(await archive.get('one', a.id)).toEqual(a);
  await expect(archive.get('two', a.id)).rejects.toThrow();
});

test('resumes immutable ordered manifests with decisions and task after reopening', async () => {
  const root = await fixture();
  const archive = new MemoryArchive(root);
  const entries = await archive.put('resume', [input('first'), input('second')]);
  const manifest: ArchiveManifest = {
    version: 1,
    task: 'Fix the parser without changing generated code.',
    entries: [
      { id: entries[1].id, mode: 'preview', callScore: 0.7, resultScore: 0.2, textScore: 0.8 },
      { id: entries[0].id, mode: 'off' },
    ],
  };
  const id = await archive.commit('resume', manifest);
  expect(id).toMatch(/^[a-f0-9]{64}$/);
  expect(await archive.commit('resume', manifest)).toBe(id);
  expect(await new MemoryArchive(root).restore('resume', id)).toEqual(manifest);
  const updated: ArchiveManifest = { ...manifest, task: 'A different task' };
  expect(await archive.commit('resume', updated)).not.toBe(id);
  expect(await archive.restore('resume', id)).toEqual(manifest);
  await expect(archive.restore('another-session', id)).rejects.toThrow();
});

test('reads bounded character pages including tool errors and original JSON structure', async () => {
  const root = await fixture();
  const archive = new MemoryArchive(root);
  const original = input('A'.repeat(18000));
  original.message.toolUses = [{ tool_use_id: 'call-1', tool: 'read', input: { path: 'a.ts' }, text: 'attached output', isError: true }];
  original.message.toolResults = [{ tool_use_id: 'call-1', text: 'failed output', isError: true }];
  original.original = { type: 'json', value: { files: ['a.ts'], count: 1 } };
  const [entry] = await archive.put('pages', [original]);
  const reopened = new MemoryArchive(root);
  const first = await reopened.read('pages', entry.id);
  expect(first).toMatchObject({ id: entry.id, offset: 0, nextOffset: 4000 });
  expect(first.text).toHaveLength(4000);
  const second = await reopened.read('pages', entry.id, first.nextOffset!, 100000);
  expect(second).toMatchObject({ offset: 4000, nextOffset: 12000 });
  expect(second.text).toHaveLength(8000);
  const last = await reopened.read('pages', entry.id, second.nextOffset!, 8000);
  expect(last.nextOffset).toBeNull();
  const text = first.text + second.text + last.text;
  expect(text).toContain('A'.repeat(18000));
  expect(text).toContain('attached output');
  expect(text).toContain('tool error');
  expect(text).toContain('failed output');
  expect(text).toContain('"count": 1');
  expect(await reopened.read('pages', entry.id, 100000)).toEqual({ id: entry.id, text: '', offset: text.length, nextOffset: null });
});

test('searches all query words as case-insensitive substrings with bounded useful excerpts', async () => {
  const root = await fixture();
  const archive = new MemoryArchive(root);
  const entries = await archive.put('search', [
    input(`${'prefix '.repeat(200)}Parser rejected the alpha configuration. ${'suffix '.repeat(200)}`),
    input('alpha alone does not match both terms'),
    ...Array.from({ length: 12 }, (_, i) => input(`Parser alpha match ${i}`)),
  ]);
  await archive.put('other', [input('Parser alpha private to another session')]);
  const reopened = new MemoryArchive(root);
  const results = await reopened.search('search', 'ALPHA   pars', 100000);
  expect(results).toHaveLength(10);
  expect(results.every((result) => result.excerpt.length <= 500)).toBe(true);
  expect(results.some((result) => result.id === entries[1].id)).toBe(false);
  const [specific] = await reopened.search('search', 'rejected alpha', 1);
  expect(specific.id).toBe(entries[0].id);
  expect(specific.excerpt).toContain('Parser rejected the alpha configuration.');
  expect(await reopened.search('search', 'not-here')).toEqual([]);
  expect(await reopened.search('search', '  ')).toEqual([]);
  expect(await reopened.search('search', '.*')).toEqual([]);
  expect(await reopened.search('new-session', 'alpha')).toEqual([]);
  expect(await reopened.search('search', 'alpha', 0)).toEqual([]);
});

test('rejects altered entry bytes and refuses to overwrite the damaged original', async () => {
  const root = await fixture();
  const archive = new MemoryArchive(root);
  const original = input('authentic');
  const [entry] = await archive.put('integrity', [original]);
  const file = await storedFile(root, `${entry.id}.json`);
  const changed = (await readFile(file, 'utf8')).replaceAll('authentic', 'forged');
  await writeFile(file, changed);
  await expect(archive.get('integrity', entry.id)).rejects.toThrow(/mismatch/);
  await expect(archive.read('integrity', entry.id)).rejects.toThrow(/mismatch/);
  await expect(archive.put('integrity', [original])).rejects.toThrow(/mismatch/);
  expect(await readFile(file, 'utf8')).toBe(changed);
});

test.each(['../outside', 'a'.repeat(63), 'a'.repeat(65), 'A'.repeat(64), `${'a'.repeat(64)}/other`])(
  'rejects unsafe or malformed pointer IDs (%s)',
  async (id) => {
    const archive = new MemoryArchive(await fixture());
    await expect(archive.get('safe', id)).rejects.toThrow(/Invalid archive ID/);
    await expect(archive.read('safe', id)).rejects.toThrow(/Invalid archive ID/);
    await expect(archive.restore('safe', id)).rejects.toThrow(/Invalid archive ID/);
  },
);

test.each([
  null,
  { ...input('ok'), source: 1 },
  { ...input('ok'), message: { role: 'system', text: 'bad', toolUses: [] } },
  { ...input('ok'), message: { role: 'user', text: 1, toolUses: [] } },
  { ...input('ok'), message: { role: 'user', text: 'bad', toolUses: [{}] } },
  { ...input('ok'), message: { role: 'user', text: 'bad', toolUses: [], toolResults: [{ tool_use_id: 'c', text: 'bad', isError: 'yes' }] } },
  { source: 'no-original', message: input('ok').message },
  { ...input('ok'), original: { value: undefined } },
  { ...input('ok'), original: { value: NaN } },
  { ...input('ok'), original: new Date('2026-10-06') },
])('rejects malformed entries or lossy non-JSON originals (%j)', async (value) => {
  const archive = new MemoryArchive(await fixture());
  await expect(archive.put('validation', [value as ArchiveInput])).rejects.toThrow(/Invalid archive/);
});

test.each([
  null,
  { version: 2, entries: [], task: 'task' },
  { version: 1, entries: [], task: null },
  { version: 1, entries: {}, task: 'task' },
  { version: 1, entries: [{ id: 'a'.repeat(64), mode: 'invalid' }], task: 'task' },
  { version: 1, entries: [{ id: '../other', mode: 'full' }], task: 'task' },
  { version: 1, entries: [{ id: 'a'.repeat(64), mode: 'full', callScore: '0.2' }], task: 'task' },
])('rejects malformed manifests before accepting a checkpoint (%j)', async (value) => {
  const archive = new MemoryArchive(await fixture());
  await expect(archive.commit('validation', value as ArchiveManifest)).rejects.toThrow(/Invalid archive/);
});

test('refuses checkpoints with missing entries, including entries lost before resume', async () => {
  const root = await fixture();
  const archive = new MemoryArchive(root);
  const missing: ArchiveManifest = { version: 1, task: 'task', entries: [{ id: 'f'.repeat(64), mode: 'full' }] };
  await expect(archive.commit('references', missing)).rejects.toThrow();
  const [entry] = await archive.put('references', [input('needed on resume')]);
  const manifest: ArchiveManifest = { ...missing, entries: [{ id: entry.id, mode: 'off' }] };
  const id = await archive.commit('references', manifest);
  await rm(await storedFile(root, `${entry.id}.json`));
  await expect(new MemoryArchive(root).restore('references', id)).rejects.toThrow();
});

test.each(['root', 'session', 'entry', 'manifest', 'search text'])(
  'fails safely when the %s is replaced with a symlink',
  async (target) => {
    const root = await fixture();
    const archive = new MemoryArchive(root);
    const original = input('private memory');
    const [entry] = await archive.put('links', [original]);
    const manifestID = await archive.commit('links', { version: 1, entries: [{ id: entry.id, mode: 'full' }], task: 'task' });
    const entryFile = await storedFile(root, `${entry.id}.json`);
    const path = target === 'root' ? root
      : target === 'session' ? dirname(entryFile)
        : target === 'entry' ? entryFile
          : await storedFile(root, `${target === 'manifest' ? manifestID + '.manifest' : entry.id + '.text'}.json`);
    const moved = join(dirname(root), `moved-${target.replaceAll(' ', '-')}`);
    await rename(path, moved);
    await symlink(moved, path);
    if (target === 'manifest') {
      await expect(archive.restore('links', manifestID)).rejects.toThrow(/Unsafe archive/);
    } else if (target === 'search text') {
      await expect(archive.search('links', 'private')).rejects.toThrow(/Unsafe archive/);
      await expect(archive.put('links', [original])).rejects.toThrow(/Unsafe archive/);
    } else {
      await expect(archive.get('links', entry.id)).rejects.toThrow(/Unsafe archive/);
      await expect(archive.put('links', [original])).rejects.toThrow(/Unsafe archive/);
      await expect(archive.restore('links', manifestID)).rejects.toThrow(/Unsafe archive/);
      await expect(archive.search('links', 'private')).rejects.toThrow(/Unsafe archive/);
    }
    expect(await readFile(entryFile, 'utf8')).toContain('private memory');
  },
);

test('keeps managed directories and files private when reopening existing memory', async () => {
  const root = await fixture();
  const archive = new MemoryArchive(root);
  const [entry] = await archive.put('../../untrusted/session', [input('private')]);
  const file = await storedFile(root, `${entry.id}.json`);
  expect((await readdir(root)).filter((name) => name !== '.gitignore')[0]).toMatch(/^[a-f0-9]{64}$/);
  await chmod(root, 0o755);
  await chmod(dirname(file), 0o755);
  await chmod(file, 0o644);
  await new MemoryArchive(root).get('../../untrusted/session', entry.id);
  expect((await stat(root)).mode & 0o777).toBe(0o700);
  expect((await stat(dirname(file))).mode & 0o777).toBe(0o700);
  expect((await stat(file)).mode & 0o777).toBe(0o600);
});

test.each([NaN, Infinity, -Infinity])('keeps search and read bounds finite for %s', async (value) => {
  const archive = new MemoryArchive(await fixture());
  const entries = await archive.put('numeric', Array.from({ length: 12 }, (_, i) => input(`needle ${i} ${'x'.repeat(9000)}`)));
  const results = await archive.search('numeric', 'needle', value);
  expect(results.length).toBeLessThanOrEqual(10);
  const page = await archive.read('numeric', entries[0].id, value, value);
  expect(Number.isFinite(page.offset)).toBe(true);
  expect(page.nextOffset === null || Number.isFinite(page.nextOffset)).toBe(true);
  expect(page.text.length).toBeLessThanOrEqual(8000);
});

test.each([null, 'x'.repeat(4097), Array.from({ length: 65 }, (_, i) => `word-${i}`).join(' ')])(
  'rejects invalid or unbounded lexical queries',
  async (query) => {
    const archive = new MemoryArchive(await fixture());
    await expect(archive.search('query', query as string)).rejects.toThrow(/Invalid archive query/);
  },
);

test('accepts explicitly undefined optional fields without losing JSON originals', async () => {
  const archive = new MemoryArchive(await fixture());
  const original = input('optional fields');
  original.message.toolResults = undefined;
  original.message.toolUses = [{ tool_use_id: 'c', tool: 'read', input: {}, text: undefined, isError: undefined }];
  const [entry] = await archive.put('optional', [original]);
  expect((await archive.get('optional', entry.id)).original).toEqual(original.original);
  const manifest: ArchiveManifest = { version: 1, task: 'task', entries: [{ id: entry.id, mode: 'full', textScore: undefined }] };
  const id = await archive.commit('optional', manifest);
  expect((await archive.restore('optional', id)).entries).toEqual([{ id: entry.id, mode: 'full' }]);
});

test('requires manifest modes to be strings rather than string-coercible values', async () => {
  const archive = new MemoryArchive(await fixture());
  const [entry] = await archive.put('modes', [input('entry')]);
  const manifest = { version: 1, task: 'task', entries: [{ id: entry.id, mode: ['full'] }] };
  await expect(archive.commit('modes', manifest as unknown as ArchiveManifest)).rejects.toThrow(/Invalid archive manifest/);
});

test.each([null, [], { id: 'a'.repeat(64), text: 1, hash: 'a'.repeat(64) }])(
  'rejects malformed search metadata instead of returning invented memory (%j)',
  async (metadata) => {
    const root = await fixture();
    const archive = new MemoryArchive(root);
    const [entry] = await archive.put('metadata', [input('needle')]);
    await writeFile(await storedFile(root, `${entry.id}.text.json`), JSON.stringify(metadata));
    await expect(archive.search('metadata', 'needle')).rejects.toThrow(/Invalid archive search metadata/);
  },
);

test.each([null, 1])('rejects non-string session IDs rather than merging namespaces', async (value) => {
  const archive = new MemoryArchive(await fixture());
  const sessionID = value as unknown as string;
  await expect(archive.put(sessionID, [input('entry')])).rejects.toThrow(/Invalid archive session/);
  await expect(archive.commit(sessionID, { version: 1, task: 'task', entries: [] })).rejects.toThrow(/Invalid archive session/);
  await expect(archive.search(sessionID, 'needle')).rejects.toThrow(/Invalid archive session/);
});

test('rejects altered manifests without replacing the original checkpoint', async () => {
  const root = await fixture();
  const archive = new MemoryArchive(root);
  const [entry] = await archive.put('manifest-integrity', [input('needed')]);
  const manifest: ArchiveManifest = { version: 1, task: 'authentic task', entries: [{ id: entry.id, mode: 'full' }] };
  const id = await archive.commit('manifest-integrity', manifest);
  const file = await storedFile(root, `${id}.manifest.json`);
  const damaged = (await readFile(file, 'utf8')).replace('authentic task', 'forged task');
  await writeFile(file, damaged);
  await expect(archive.restore('manifest-integrity', id)).rejects.toThrow(/mismatch/);
  await expect(archive.commit('manifest-integrity', manifest)).rejects.toThrow(/mismatch/);
  expect(await readFile(file, 'utf8')).toBe(damaged);
});

test('fails rather than trusting tampered search text or matching original content', async () => {
  const root = await fixture();
  const archive = new MemoryArchive(root);
  const [entry] = await archive.put('search-integrity', [input('needle')]);
  const metadataFile = await storedFile(root, `${entry.id}.text.json`);
  const metadata = await readFile(metadataFile, 'utf8');
  await writeFile(metadataFile, metadata.replaceAll('needle', 'invented'));
  await expect(archive.search('search-integrity', 'invented')).rejects.toThrow(/mismatch/);
  await writeFile(metadataFile, metadata);
  const entryFile = await storedFile(root, `${entry.id}.json`);
  await writeFile(entryFile, (await readFile(entryFile, 'utf8')).replaceAll('needle', 'forged'));
  await expect(archive.search('search-integrity', 'needle')).rejects.toThrow(/mismatch/);
});

test('fails explicitly when an entry loses its search metadata', async () => {
  const root = await fixture();
  const archive = new MemoryArchive(root);
  const [entry] = await archive.put('missing-metadata', [input('needle')]);
  await rm(await storedFile(root, `${entry.id}.text.json`));
  await expect(archive.search('missing-metadata', 'needle')).rejects.toThrow();
  expect((await archive.read('missing-metadata', entry.id)).text).toContain('needle');
});

test('creates a private immutable ignore file inside arbitrary archive roots', async () => {
  const root = await fixture();
  await new MemoryArchive(root).put('ignore', [input('private')]);
  const path = join(root, '.gitignore');
  expect(await readFile(path, 'utf8')).toBe('*\n');
  const first = await stat(path);
  expect(first.mode & 0o777).toBe(0o600);
  await new MemoryArchive(root).put('ignore', [input('private')]);
  expect((await stat(path)).ino).toBe(first.ino);
});

test.each(['callScore', 'resultScore', 'textScore'].flatMap((name) => [-0.01, 1.01].map((score) => ({ name, score }))))(
  'rejects out-of-range $name probabilities ($score)',
  async ({ name, score }) => {
    const archive = new MemoryArchive(await fixture());
    const [entry] = await archive.put('score-range', [input('entry')]);
    const manifest: ArchiveManifest = { version: 1, task: 'task', entries: [{ id: entry.id, mode: 'full', [name]: score }] };
    await expect(archive.commit('score-range', manifest)).rejects.toThrow(/Invalid archive score/);
  },
);

test('rejects duplicate entry IDs before accepting a manifest', async () => {
  const archive = new MemoryArchive(await fixture());
  const [entry] = await archive.put('duplicates', [input('entry')]);
  const manifest: ArchiveManifest = {
    version: 1,
    task: 'task',
    entries: [{ id: entry.id, mode: 'full' }, { id: entry.id, mode: 'off' }],
  };
  await expect(archive.commit('duplicates', manifest)).rejects.toThrow(/Duplicate archive ID/);
});

test.each(['same instance', 'fresh instance'])('rejects newly off entries corrupted after put on the %s', async (instance) => {
  const root = await fixture();
  const archive = new MemoryArchive(root);
  const [entry] = await archive.put('new-off', [input('authentic content')]);
  const file = await storedFile(root, `${entry.id}.json`);
  const authentic = await readFile(file, 'utf8');
  await writeFile(file, authentic.replaceAll('authentic content', 'forged content'));
  const writer = instance === 'same instance' ? archive : new MemoryArchive(root);
  const manifest: ArchiveManifest = { version: 1, task: 'task', entries: [{ id: entry.id, mode: 'off' }] };
  await expect(writer.commit('new-off', manifest)).rejects.toThrow(/mismatch/);
  await expect(writer.commit('new-off', manifest)).rejects.toThrow(/mismatch/);
  await writeFile(file, authentic);
  const id = await writer.commit('new-off', manifest);
  expect(await new MemoryArchive(root).restore('new-off', id)).toEqual(manifest);
});

test.each(['before retrieval', 'after retrieval'])('rechecks retrieved off entries even when restoring %s', async (restoreOrder) => {
  const root = await fixture();
  const archive = new MemoryArchive(root);
  const [entry] = await archive.put('retrieved-off', [input('authentic content')]);
  const manifest: ArchiveManifest = { version: 1, task: 'task', entries: [{ id: entry.id, mode: 'off' }] };
  const id = await archive.commit('retrieved-off', manifest);
  const reopened = new MemoryArchive(root);
  if (restoreOrder === 'before retrieval') await reopened.restore('retrieved-off', id);
  expect(await reopened.get('retrieved-off', entry.id)).toEqual(entry);
  if (restoreOrder === 'after retrieval') await reopened.restore('retrieved-off', id);
  const file = await storedFile(root, `${entry.id}.json`);
  await writeFile(file, (await readFile(file, 'utf8')).replaceAll('authentic content', 'forged content'));
  await expect(reopened.commit('retrieved-off', manifest)).rejects.toThrow(/mismatch/);
  await expect(reopened.commit('retrieved-off', manifest)).rejects.toThrow(/mismatch/);
});

test('resumes off entries by existence while verifying their contents on public retrieval', async () => {
  const root = await fixture();
  const archive = new MemoryArchive(root);
  const [entry] = await archive.put('off-resume', [input('historical content')]);
  const manifest: ArchiveManifest = { version: 1, task: 'task', entries: [{ id: entry.id, mode: 'off' }] };
  const id = await archive.commit('off-resume', manifest);
  const file = await storedFile(root, `${entry.id}.json`);
  await writeFile(file, (await readFile(file, 'utf8')).replaceAll('historical content', 'altered content'));
  const reopened = new MemoryArchive(root);
  expect(await reopened.restore('off-resume', id)).toEqual(manifest);
  expect(await reopened.commit('off-resume', manifest)).toBe(id);
  expect(await archive.commit('off-resume', manifest)).toBe(id);
  await expect(new MemoryArchive(root).commit('off-resume', manifest)).rejects.toThrow(/mismatch/);
  await expect(archive.get('off-resume', entry.id)).rejects.toThrow(/mismatch/);
  await expect(archive.read('off-resume', entry.id)).rejects.toThrow(/mismatch/);
  await expect(archive.commit('off-resume', manifest)).rejects.toThrow(/mismatch/);
  expect(await archive.restore('off-resume', id)).toEqual(manifest);
  await expect(archive.commit('off-resume', manifest)).rejects.toThrow(/mismatch/);
});

test('rechecks previously off entries returned by a deduplicated put', async () => {
  const root = await fixture();
  const archive = new MemoryArchive(root);
  const original = input('authentic content');
  const [entry] = await archive.put('repeated-put', [original]);
  const manifest: ArchiveManifest = { version: 1, task: 'task', entries: [{ id: entry.id, mode: 'off' }] };
  const id = await archive.commit('repeated-put', manifest);
  const reopened = new MemoryArchive(root);
  await reopened.restore('repeated-put', id);
  expect(await reopened.put('repeated-put', [original])).toEqual([entry]);
  const file = await storedFile(root, `${entry.id}.json`);
  await writeFile(file, (await readFile(file, 'utf8')).replaceAll('authentic content', 'forged content'));
  await expect(reopened.commit('repeated-put', manifest)).rejects.toThrow(/mismatch/);
});

test('keeps untouched historical off entries independent of another session checkpoint', async () => {
  const root = await fixture();
  const archive = new MemoryArchive(root);
  const [first] = await archive.put('first-session', [input('first authentic content')]);
  const firstManifest: ArchiveManifest = { version: 1, task: 'first task', entries: [{ id: first.id, mode: 'off' }] };
  const firstID = await archive.commit('first-session', firstManifest);
  const file = await storedFile(root, `${first.id}.json`);
  const [second] = await archive.put('second-session', [input('second content')]);
  await archive.get('second-session', second.id);
  await archive.commit('second-session', { version: 1, task: 'second task', entries: [{ id: second.id, mode: 'off' }] });
  await writeFile(file, (await readFile(file, 'utf8')).replaceAll('first authentic content', 'forged content'));
  expect(await archive.commit('first-session', firstManifest)).toBe(firstID);
  await expect(new MemoryArchive(root).commit('first-session', firstManifest)).rejects.toThrow(/mismatch/);
});

test('preserves examined entries after a failed manifest publication', async () => {
  const root = await fixture();
  const archive = new MemoryArchive(root);
  const [entry] = await archive.put('failed-publication', [input('authentic content')]);
  const manifest: ArchiveManifest = { version: 1, task: 'authentic task', entries: [{ id: entry.id, mode: 'off' }] };
  const id = await archive.commit('failed-publication', manifest);
  expect(await archive.get('failed-publication', entry.id)).toEqual(entry);
  const manifestFile = await storedFile(root, `${id}.manifest.json`);
  await writeFile(manifestFile, (await readFile(manifestFile, 'utf8')).replace('authentic task', 'forged task'));
  await expect(archive.commit('failed-publication', manifest)).rejects.toThrow(/mismatch/);
  const file = await storedFile(root, `${entry.id}.json`);
  await writeFile(file, (await readFile(file, 'utf8')).replaceAll('authentic content', 'forged content'));
  await expect(archive.commit('failed-publication', { ...manifest, task: 'retry task' })).rejects.toThrow(/mismatch/);
});

test.each(['incompatible content', 'symlink'])('refuses an existing root ignore file with %s', async (kind) => {
  const root = await fixture();
  await mkdir(root, { mode: 0o700 });
  const ignore = join(root, '.gitignore');
  const content = kind === 'symlink' ? '*\n' : 'a-user-owned-rule\n';
  if (kind === 'symlink') {
    const outside = join(dirname(root), 'outside-ignore');
    await writeFile(outside, content);
    await symlink(outside, ignore);
  } else {
    await writeFile(ignore, content);
  }
  const before = await stat(ignore);
  await expect(new MemoryArchive(root).put('ignore', [input('private')])).rejects.toThrow(/mismatch|Unsafe archive/);
  expect(await readFile(ignore, 'utf8')).toBe(content);
  expect((await stat(ignore)).mode).toBe(before.mode);
  expect(await readdir(root)).toEqual(['.gitignore']);
});

test('preserves entry and manifest order across multiple concurrent batches', async () => {
  const root = await fixture();
  const archive = new MemoryArchive(root);
  const inputs = Array.from({ length: 25 }, (_, i) => input(`${i}: ${'variable '.repeat(i * 20)}`));
  const entries = await archive.put('batch-order', inputs);
  expect(entries.map((entry) => entry.message.text)).toEqual(inputs.map((entry) => entry.message.text));
  const manifest: ArchiveManifest = {
    version: 1,
    task: 'keep the original order',
    entries: entries.slice().reverse().map(({ id }, i) => ({ id, mode: i % 3 === 0 ? 'off' : i % 3 === 1 ? 'preview' : 'full', callScore: 0, resultScore: 1 })),
  };
  const id = await archive.commit('batch-order', manifest);
  expect(await new MemoryArchive(root).restore('batch-order', id)).toEqual(manifest);
  expect(await archive.put('batch-order', inputs)).toEqual(entries);
});
