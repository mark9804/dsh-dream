import assert from 'node:assert/strict';
import test from 'node:test';
import { isDreamVerificationSession } from '../dist/settings/session-fixtures.js';
import { isMainConversation, createSettingsSessionDirectory } from '../dist/settings/sessions.js';
const uuid = '760c5af0-4955-4717-be80-10e6db8292cb';
const base = '/synthetic/projects/dsh-dream/tests/.tmp/';
const cases = [
  ['dream-native-terminal-', 'compaction-host-Xfl4qJ'],
  ['dream-compact-originals-', 'compaction-host-O1ay4Q'],
  ['dream-compact-auto-skip-', 'compaction-host-O1ay4Q/auto-skip'],
  ['dream-compact-dream-compact-', 'compaction-host-O1ay4Q/dream-compact'],
  ['dream-continuity-owner-', 'continuity-host-aB12cD'],
  ['dream-continuity-originals-', 'continuity-host-aB12cD'],
  ['dream-consolidation-fixture-', 'consolidation-recall-live-aB12cD'],
  ['dream-daily-fixture-', 'memory-v2-live-2026-11-06T10-22-33-456Z'],
  ['dream-fixture-source-', 'original-recall-live-2026-11-06T10-22-33-456Z'],
];
for (const [prefix, folder] of cases) test(`hides exact authored fixture metadata: ${prefix}`, () => {
  const header = { id: prefix + uuid, cwd: base + folder, isSeeded: false };
  assert.equal(isDreamVerificationSession(header), true);
  assert.equal(isMainConversation(header), false);
  assert.equal(isDreamVerificationSession({ ...header, cwd: header.cwd + '/' }), true);
  assert.equal(isDreamVerificationSession({ ...header, cwd: header.cwd + '/other' }), false);
  assert.equal(isDreamVerificationSession({ ...header, parentSession: 'ordinary-user-root' }), false);
  assert.equal(isDreamVerificationSession({ ...header, isSeeded: true }), false);
});
test('name or title alone never hides ordinary conversations', () => {
  for (const [prefix] of cases) {
    for (const cwd of [undefined, '/synthetic/projects/notes', '/synthetic/projects/not-dsh-dream/tests/.tmp/compaction-host-Xfl4qJ', '/synthetic/tests/.tmp/compaction-host-Xfl4qJ']) {
      assert.equal(isMainConversation({ id: prefix + uuid, cwd }), true);
    }
  }
});
test('generic temporary project directories and existing supplied test targets remain selectable', () => {
  for (const cwd of [base + 'compaction-host-Xfl4qJ', base + 'other-fixture', base + 'continuity-host-aB12cD']) {
    assert.equal(isMainConversation({ id: 'session-user-chosen-target', cwd }), true);
  }
});
test('strict ID directory pairing excludes neither crossed cases nor malformed lookalikes', () => {
  for (const [id, cwd] of [
    ['dream-compact-auto-skip-' + uuid, base + 'compaction-host-O1ay4Q/dream-compact'],
    ['dream-compact-dream-compact-' + uuid, base + 'compaction-host-O1ay4Q/auto-skip'],
    ['dream-native-terminal-' + uuid, base + 'compaction-host-Xfl4qJ/auto-skip'],
    ['dream-native-terminal-not-a-uuid', base + 'compaction-host-Xfl4qJ'],
    ['dream-native-terminal-' + uuid, base + 'compaction-host-Xfl4qJ-extended'],
    ['dream-native-terminal-' + uuid, 'dsh-dream/tests/.tmp/compaction-host-Xfl4qJ'],
    ['dream-native-terminal-' + uuid, '/synthetic/dsh-dream/tests/.tmp/../.tmp/compaction-host-Xfl4qJ'],
  ]) assert.equal(isMainConversation({ id, cwd }), true);
});
test('Windows Host metadata uses the same exact driver path shape', () => {
  assert.equal(isDreamVerificationSession({ id: 'dream-native-terminal-' + uuid, cwd: 'C:\\synthetic\\dsh-dream\\tests\\.tmp\\compaction-host-Xfl4qJ' }), true);
});
test('fixture sessions are filtered before matching, title lookup and the 100-result cap without cold reads', async () => {
  const fixtureRows = Array.from({ length: 300 }, (_, i) => ({ header: { id: 'dream-native-terminal-' + uuid.replace('760c5af0', i.toString(16).padStart(8, '0')), cwd: base + 'compaction-host-Xfl4qJ' }, live: false, persisted: true }));
  const normal = { header: { id: 'session-human', cwd: '/synthetic/notes' }, live: false, persisted: true };
  const lookups = [];
  const services = {
    sessionQuery: { async listSessions() { return [...fixtureRows, normal]; }, async readTitleSnapshots() { assert.fail('No cold replay'); } },
    sessions: { get(id) { lookups.push(id); return undefined; } },
    sessionProjectionCache: { cachedSnapshot() { return { values: { title: 'Normal conversation' } }; } },
  };
  const directory = createSettingsSessionDirectory({ get: key => services[key] });
  const result = await directory.search('');
  assert.deepEqual(result.items.map(item => item.id), ['session-human']); assert.equal(result.truncated, false);
  assert.deepEqual(lookups, ['session-human']);
  assert.deepEqual((await directory.search('dream-native-terminal')).items, []);
  await directory.dispose();
});
