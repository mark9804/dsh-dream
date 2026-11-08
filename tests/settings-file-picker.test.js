import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createPersonaFilePicker, MAC_FILE_PANEL } from '../dist/harness/file-picker.js';
function fixture({ kind = 'native', platform = 'darwin', output = '/synthetic/persona.md\n', lossy = false, exitCode = 0, exitSignal = null, deferred = false, subprocess = true } = {}) {
  let settle;
  const specs = [], terminated = [];
  const done = deferred ? new Promise(resolve => { settle = resolve; }) : Promise.resolve({ exitCode, signal: exitSignal });
  const handle = { done, collected: { stdout: { readFrom(offset) { assert.equal(offset, 0); return { text: output, lossy }; } } }, terminate() { terminated.push(true); } };
  const services = { directoryPicker: { capability: () => ({ kind }) }, ...(subprocess ? { subprocess: { spawn(spec) { specs.push(spec); return handle; } } } : {}) };
  return { picker: createPersonaFilePicker({ get: key => services[key] }, platform), specs, terminated, finish: () => settle?.({ exitCode, signal: exitSignal }) };
}
const unavailable = error => error.code === 'UNAVAILABLE';
test('macOS file picker launches fixed AppKit source through the public subprocess seam', async () => {
  const f = fixture();
  assert.equal(await f.picker.pick(new AbortController().signal), '/synthetic/persona.md');
  const spec = f.specs[0]; assert.deepEqual(spec.argv, ['/usr/bin/osascript', '-l', 'JavaScript', '-e', MAC_FILE_PANEL]);
  assert.equal(spec.cwd, '/'); assert.equal(spec.stdio.stdin, 'ignore'); assert.equal(spec.stdio.stdout.maxBytes, 16384);
  assert.match(MAC_FILE_PANEL, /panel\.canChooseFiles = true/); assert.match(MAC_FILE_PANEL, /panel\.canChooseDirectories = false/);
  assert.match(MAC_FILE_PANEL, /Paste/); assert.match(MAC_FILE_PANEL, /showsHiddenFiles = true/);
  await f.picker.dispose();
});
test('chooser cancellation returns null rather than an invented filename', async () => {
  const f = fixture({ output: '\n' }); assert.equal(await f.picker.pick(new AbortController().signal), null); await f.picker.dispose();
});
test('unsupported, browse or absent provider refuses without subprocess launch', async () => {
  for (const options of [{ platform: 'linux' }, { kind: 'browse' }, { subprocess: false }]) {
    const f = fixture(options); assert.equal(f.picker.available(), false);
    await assert.rejects(f.picker.pick(new AbortController().signal), unavailable); assert.equal(f.specs.length, 0); await f.picker.dispose();
  }
});
test('chooser failures and untrusted output cannot become selected paths', async () => {
  for (const options of [{ exitCode: 1 }, { exitSignal: 'SIGTERM' }, { lossy: true }, { output: 'relative.md\n' }, { output: '/one\n/two\n' }, { output: '/nul\0.md\n' }]) {
    const f = fixture(options); await assert.rejects(f.picker.pick(new AbortController().signal), unavailable); await f.picker.dispose();
  }
});
test('aborted caller never starts a chooser; abort of a running chooser waits for actual close', async () => {
  const already = new AbortController(); already.abort(); const a = fixture(); await assert.rejects(a.picker.pick(already.signal)); assert.equal(a.specs.length, 0); await a.picker.dispose();
  const caller = new AbortController(), f = fixture({ deferred: true });
  let finished = false; const work = f.picker.pick(caller.signal).finally(() => { finished = true; });
  caller.abort(); await Promise.resolve(); assert.equal(finished, false); assert.equal(f.terminated.length, 1);
  f.finish(); await assert.rejects(work); await f.picker.dispose();
});
test('dispose cancels and drains an open chooser, and overlapping dialogs are rejected', async () => {
  const f = fixture({ deferred: true }), work = f.picker.pick(new AbortController().signal);
  await assert.rejects(f.picker.pick(new AbortController().signal), unavailable); assert.equal(f.specs.length, 1);
  let closed = false; const cleanup = f.picker.dispose().then(() => { closed = true; });
  await Promise.resolve(); assert.equal(closed, false); assert.equal(f.terminated.length, 1);
  f.finish(); await assert.rejects(work); await cleanup;
  await assert.rejects(f.picker.pick(new AbortController().signal)); assert.equal(f.specs.length, 1);
});
test('persona UI uses a file chooser, updates only the draft, and hides relocation warning during first setup', async () => {
  const page = await readFile(new URL('../client/SettingsPage.tsx', import.meta.url), 'utf8');
  const entry = await readFile(new URL('../src/settings/entry.ts', import.meta.url), 'utf8');
  assert.match(page, /await api\.pickFile\(controller\.signal\)/); assert.match(page, /path !== null\) update\(field, path\)/);
  assert.match(page, /field === 'personaPath' \? 'browseFile'/); assert.doesNotMatch(page, /fileBrowseUnavailable/);
  assert.match(page, /!!text\(snapshot\?\.config\.stateRoot\)/);
  assert.match(entry, /'pick-file': async \(input, signal\) => \{ empty\(input\); return filePicker\.pick\(signal\); \}/);
  assert.doesNotMatch(entry, /tools\.register/);
});
