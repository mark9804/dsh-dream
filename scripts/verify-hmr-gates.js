import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStage, runCheckedBuild } from './checked-build.js';
import { digest } from './lib/build-inputs.js';
const project = fileURLToPath(new URL('..', import.meta.url));
const paths = ['.dream-dev/runtime/generation.js', '.dream-dev/runtime/web/client.js'];
const before = {};
for (const path of paths) before[path] = digest(await readFile(join(project, path)));
const results = [];
for (const failure of ['type', 'syntax', 'manifest']) {
  const stage = await createStage(project);
  if (failure === 'type') await writeFile(join(stage.staged, 'src/__synthetic_gate_error.ts'), 'export const gate: string = 123;\n');
  if (failure === 'syntax') await writeFile(join(stage.staged, 'scripts/__synthetic_gate_error.js'), 'const gate = ;\n');
  if (failure === 'manifest') { const path = join(stage.staged, 'package-lock.json'), data = JSON.parse(await readFile(path, 'utf8')); data.version = '0.0.0'; await writeFile(path, JSON.stringify(data)); }
  await assert.rejects(runCheckedBuild({ root: stage.staged, publish: false, tests: false }));
  for (const path of paths) assert.equal(digest(await readFile(join(project, path))), before[path], 'Rejected generation changed installed runtime');
  results.push({ failure, rejected: true, installedRuntimeUnchanged: true });
}
const proof = { state: 'completed', results, noPersonalStateReads: true, noModelCalls: true, noTaskRetry: true, at: new Date().toISOString() };
await writeFile(join(project, 'tests/.tmp/hmr-gate-verification.json'), JSON.stringify(proof, null, 2));
console.log(JSON.stringify(proof, null, 2));
