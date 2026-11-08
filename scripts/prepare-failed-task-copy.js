import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, mkdtemp, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join, relative, isAbsolute, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateJob } from '../dist/domain/contracts.js';
// Explicit one-off authorization: copy this exact failed job's frozen inputs only.
// Never installed, never auto-run by npm test, never reads a credential or calls a model.
const originalJob = '/Users/zhaoluchen/.dsh/dream-state/jobs/e0458b37-5c8f-416f-a5e1-c919009d5907.json';
const realMemory = '/Users/zhaoluchen/.dsh/memory', realPersona = '/Users/zhaoluchen/.dsh/AGENTS.md';
const project = await realpath(fileURLToPath(new URL('..', import.meta.url))), temporary = join(project, 'tests/.tmp');
await mkdir(temporary, { recursive: true });
const root = await mkdtemp(join(temporary, 'private-timeout-copy-')); await mkdir(join(root, 'original'), { mode: 0o700 }); await mkdir(join(root, 'memory'), { mode: 0o700 });
function within(base, value) { const part = relative(base, value); assert.ok(part !== '..' && !part.startsWith('../') && !isAbsolute(part)); return value; }
const hash = value => createHash('sha256').update(value).digest('hex');
const raw = await readFile(originalJob, 'utf8'), job = validateJob(JSON.parse(raw));
assert.equal(job.jobId, 'e0458b37-5c8f-416f-a5e1-c919009d5907'); assert.equal(job.state, 'failed'); assert.equal(job.phase, 'generating');
assert.equal(job.proposals.length, 0); assert.equal(job.reviews.length, 0); assert.equal(job.appliedProposalIds.length, 0); assert.equal(job.transaction, undefined);
await writeFile(join(root, 'original', 'job.json'), raw, { flag: 'wx', mode: 0o600 });
const originals = [{ path: originalJob, sha256: hash(raw) }];
for (const source of job.snapshot.sources) {
  assert.ok(!isAbsolute(source.path) && !source.path.split(/[\\/]/u).includes('..'));
  const destination = within(root, source.role === 'persona' ? join(root, 'persona.md') : join(root, 'memory', source.path));
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  await writeFile(destination, source.content, { flag: 'wx', mode: 0o600 });
  const originalPath = source.role === 'persona' ? realPersona : within(realMemory, resolve(realMemory, source.path));
  originals.push({ path: originalPath, sha256: hash(await readFile(originalPath)) });
}
const profilePath = '/Users/zhaoluchen/.dsh/profiles/desktop/cordis.patch.yml';
originals.push({ path: profilePath, sha256: hash(await readFile(profilePath)) });
const installedPackage = '/Users/zhaoluchen/.dsh/profiles/desktop/node_modules/dsh-dream/package.json';
originals.push({ path: installedPackage, sha256: hash(await readFile(installedPackage)) });
const manifest = { schemaVersion: 1, root, sourceJobId: job.jobId, copiedAt: new Date().toISOString(), sourceCount: job.snapshot.sources.length,
  privateCopy: true, origin: 'authorized frozen failed-job snapshot, not current live memory', originals, noModelCalls: true, noProfileChanges: true };
await writeFile(join(root, 'manifest.json'), JSON.stringify(manifest, null, 2), { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify({ root, sourceJobId: job.jobId, sourceCount: manifest.sourceCount, noLiveWrites: true, noModelCalls: true, personalTextPrinted: false }, null, 2));
