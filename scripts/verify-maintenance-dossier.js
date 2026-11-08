import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
const root = resolve(process.argv[2] ?? ''), docs = ['docs/maintenance-cost-2026-11-05.md','docs/maintenance-cost-content-audited-2026-11-05.md','README.md','docs/development.md'];
assert.ok(root.includes('/tests/.tmp/continuity-host-'));
let links = 0;
for (const p of docs) {
  const path = resolve(p), text = await readFile(path, 'utf8');
  for (const m of text.matchAll(/\]\(<?([^)>]+)>?\)/g)) {
    if (/^https?:/.test(m[1])) continue;
    await stat(resolve(dirname(path), decodeURI(m[1].split('#')[0]))); links++;
  }
}
const dossier = await readFile(resolve(docs[1]), 'utf8'), fixture = JSON.parse(await readFile(join(root, 'fixture-gold.json'), 'utf8')); let proposals = 0, reviews = 0;
for (const night of fixture.nights) {
  const job = JSON.parse(await readFile(join(root, 'final/' + night.id + '.json'), 'utf8'));
  for (const p of job.proposals) { assert.ok(dossier.includes(JSON.stringify(p, null, 2))); proposals++; }
  for (const r of job.reviews) { assert.ok(dossier.includes(r.reason)); reviews++; }
  assert.ok(dossier.includes(await readFile(join(root, 'memory-' + night.id + '.md'), 'utf8')));
}
console.log(JSON.stringify({ links, proposals, reviews, finalMemoryExact: true }));
