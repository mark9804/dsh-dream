import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import test from 'node:test';
import { collectSnapshot, inputFingerprint, protectedText, sourcePath } from '../dist/dream/materials.js';
import { validateSnapshot } from '../dist/domain/contracts.js';
import { createLocalFiles } from '../dist/storage/local-files.js';

const scope = { scopeId: 'scope', agentId: 'agent', sessionId: 'session', memoryRootId: 'memory' };
const now = new Date('2026-11-02T05:30:00-05:00');

async function fixture(t) {
  const temporaryRoot = fileURLToPath(new URL('.tmp/', import.meta.url));
  await mkdir(temporaryRoot, { recursive: true });
  const directory = await mkdtemp(join(temporaryRoot, 'materials-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  async function write(path, content) {
    await mkdir(dirname(join(directory, path)), { recursive: true });
    await writeFile(join(directory, path), content);
  }
  await mkdir(join(directory, 'memory/daily'), { recursive: true });
  await mkdir(join(directory, 'memory/ideas'), { recursive: true });
  await write('memory/long-term.md', '## 称呼\nSynthetic name.\n## 普通记录\nAn old memory.\n');
  await write('memory/decisions.md', 'Synthetic decision.\n');
  await write('memory/journal.md', 'Synthetic journal.\n');
  await write('persona/AGENTS.md', '## 红线\nSynthetic boundary.\n## Traits\nBe concise.\n');
  const config = { memoryRoot: 'memory', personaPath: 'persona/AGENTS.md', timeZone: 'America/New_York', maxSourceBytes: 131072, maxInputBytes: 524288 };
  return { directory, write, config, files: createLocalFiles(directory) };
}

const collect = (files, config) => collectSnapshot(files, config, scope, { now, snapshotId: 'snapshot' });

test('collection reads only configured sources and the recent three local diary dates', async (t) => {
  const { files, config, write } = await fixture(t);
  for (const name of ['2026-11-02', '26-11-01', '2026-10-31', '2026-10-30', '2026-11-03']) await write(`memory/daily/${name}.md`, `Synthetic ${name}.\n`);
  await write('memory/daily/nested/2026-11-02.md', 'Must not be read.');
  await write('memory/ideas/current.md', '<!-- sensitive -->\nSynthetic idea.');
  await write('memory/ideas/ignored.txt', 'Must not be read.');
  await write('memory/archive/old.md', 'Must not be read.');
  await write('memory/dreams/26-11-02.md', 'Must not be read.');
  await write('outside/private.md', 'Must not be read.');
  const reads = [];
  const snapshot = await collect({ ...files, read: async (path) => { reads.push(path); return files.read(path); } }, config);
  assert.equal(validateSnapshot(snapshot), snapshot);
  assert.deepEqual(snapshot.sources.filter(source => source.role === 'daily').map(source => source.path).sort(), ['daily/2026-10-31.md', 'daily/2026-11-02.md', 'daily/26-11-01.md']);
  assert.deepEqual(reads.sort(), ['memory/long-term.md', 'memory/decisions.md', 'memory/journal.md', 'memory/daily/2026-10-31.md', 'memory/daily/2026-11-02.md', 'memory/daily/26-11-01.md', 'memory/ideas/current.md', 'persona/AGENTS.md'].sort());
  assert.equal(snapshot.sources.find(source => source.role === 'ideas').sensitivity, 'sensitive');
  const persona = snapshot.sources.find(source => source.role === 'persona');
  assert.equal(persona.path, 'AGENTS.md');
  assert.equal(sourcePath(config, persona), 'persona/AGENTS.md');
});

test('manual diary edits change the generation fingerprint; ordering and timestamps do not', async (t) => {
  const { files, config, write } = await fixture(t);
  await write('memory/daily/2026-11-02.md', 'Synthetic event, first draft.\n');
  const original = await collect(files, config);
  const reordered = { ...original, snapshotId: 'another-snapshot', capturedAt: '2026-11-02T12:00:00Z', sources: [...original.sources].reverse() };
  assert.equal(inputFingerprint(original), inputFingerprint(reordered));
  await write('memory/daily/2026-11-02.md', 'Synthetic event, manually corrected.\n');
  const edited = await collect(files, config);
  assert.notEqual(inputFingerprint(original), inputFingerprint(edited));
});

test('empty required directories are valid but missing required directories or files fail', async (t) => {
  const { directory, files, config, write } = await fixture(t);
  const snapshot = await collect(files, config);
  assert.equal(snapshot.sources.filter(source => source.role === 'daily' || source.role === 'ideas').length, 0);
  await rm(join(directory, 'memory/ideas'), { recursive: true });
  await assert.rejects(collect(files, config), /Missing configured directory: ideas/);
  await mkdir(join(directory, 'memory/ideas'));
  await rm(join(directory, 'memory/long-term.md'));
  await assert.rejects(collect(files, config), /Missing configured source: long-term.md/);
  await write('memory/long-term.md', 'Restored synthetic memory.');
  await rm(join(directory, 'persona/AGENTS.md'));
  await assert.rejects(collect(files, config), /Missing configured source: AGENTS.md/);
});

test('a selected source removed before reading is an explicit failure', async (t) => {
  const { directory, files, config, write } = await fixture(t);
  await write('memory/daily/2026-11-02.md', 'Synthetic event.');
  const removed = 'memory/daily/2026-11-02.md';
  const deletingFiles = { ...files, read: async (path) => {
    if (path === removed) await rm(join(directory, path));
    return files.read(path);
  } };
  await assert.rejects(collect(deletingFiles, config), /Missing configured source: daily\/2026-11-02.md/);
});

test('source and aggregate byte budgets stop collection before model generation', async (t) => {
  const { files, config } = await fixture(t);
  await assert.rejects(collect(files, { ...config, maxSourceBytes: 1 }), /Material budget exceeded/);
  await assert.rejects(collect(files, { ...config, maxInputBytes: 1 }), /Material budget exceeded/);
});

test('oversized metadata rejects a source without reading its content', async (t) => {
  const { files, config } = await fixture(t);
  let reads = 0;
  await assert.rejects(collect({ ...files, read: async () => { reads++; assert.fail('oversized content must not be read'); } }, { ...config, maxSourceBytes: 1 }), /Material budget exceeded/);
  assert.equal(reads, 0);
});

test('each read gets the smaller source and remaining aggregate budget', async (t) => {
  const { files, config } = await fixture(t);
  let remaining = config.maxInputBytes;
  const bounded = { ...files, read: async (path, options) => {
    assert.equal(options.maxBytes, Math.min(config.maxSourceBytes, remaining));
    const result = await files.read(path, options);
    remaining -= Buffer.byteLength(result.content);
    return result;
  } };
  await collect(bounded, config);
  const total = config.maxInputBytes - remaining;
  remaining = total;
  await collect(bounded, { ...config, maxInputBytes: total });
  assert.equal(remaining, 0);
});

test('growth between metadata and bounded read produces a budget failure', async (t) => {
  const { files, config, write } = await fixture(t);
  let reads = 0;
  const growing = { ...files, read: async (path, options) => {
    reads++;
    await write(path, 'x'.repeat(options.maxBytes + 1));
    return files.read(path, options);
  } };
  await assert.rejects(collect(growing, config), /Material budget exceeded/);
  assert.equal(reads, 1);
});

test('unknown metadata size still requires a bounded read and checks actual bytes', async (t) => {
  const { files, config } = await fixture(t);
  const unknownSize = { ...files,
    stat: async path => { const info = await files.stat(path); if (info) delete info.size; return info; },
    read: async (path, options) => {
      assert.equal(options.maxBytes, 1);
      throw Object.assign(new Error('bounded backend rejected growth'), { code: 'FS_TOO_LARGE' });
    },
  };
  await assert.rejects(collect(unknownSize, { ...config, maxInputBytes: 1 }), /Material budget exceeded/);
});

test('explicit pins and protected sections include nested content but exclude ordinary siblings', () => {
  const pin = '<!-- pinned:start -->\nAn explicit synthetic pin.\n<!-- pinned:end -->';
  const headings = ['称呼', '红线', '用户的研究方向', '论文', '正在进行的约定', '进行中的约定'];
  const content = `${pin}\n${headings.map(heading => `## ${heading}\nKeep ${heading}.\n### Detail\nKeep its detail.\n`).join('')}## 普通记录\nEditable synthetic content.\n`;
  const protectedSpans = protectedText(content, 'longTerm');
  assert.ok(protectedSpans.includes(pin));
  for (const heading of headings) assert.ok(protectedSpans.some(span => span.startsWith(`## ${heading}\n`) && span.includes('Keep its detail.')));
  assert.ok(protectedSpans.every(span => !span.includes('Editable synthetic content.')));
});

test('unmarked persona text remains protected while clearly separated ordinary traits can change', () => {
  const plain = 'An existing synthetic persona with no protection markers.';
  assert.deepEqual(protectedText(plain, 'persona'), [plain]);
  const structured = '## 红线\nSynthetic boundary.\n## Traits\nEditable trait.\n';
  assert.deepEqual(protectedText(structured, 'persona'), ['## 红线\nSynthetic boundary.\n']);
});
