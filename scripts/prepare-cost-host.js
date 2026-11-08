// Same full synthetic three-night corpus as the earlier real trial. Reuse the
// fixture, not any model decisions. No repeat Q&A (outside maintenance scope).
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
const [artifact, target] = process.argv.slice(2);
const result = spawnSync(process.execPath, ['scripts/prepare-continuity-host.js', artifact, target], { cwd: import.meta.dirname + '/..', encoding: 'utf8' });
assert.equal(result.status, 0, result.stderr); const prepared = JSON.parse(result.stdout);
const entryPath = join(prepared.bundle, 'index.js'), manifestPath = join(prepared.root, 'manifest.json');
const oldEntry = await readFile(entryPath, 'utf8'), manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
assert.ok(oldEntry.includes('run(ctx,'));
await writeFile(entryPath, `import{apply as run,inject}from'./lib/continuity-host-driver.js';export{inject};export const apply=ctx=>run(ctx,${JSON.stringify({ root: prepared.root, target, ownerId: prepared.ownerId, skipQuestions: true, maxIsolatedCalls: process.argv[4] === 'smoke' ? 6 : 18, ...(process.argv[4] === 'smoke' ? { maxNights: 1 } : {}) })});\n`);
await writeFile(manifestPath, JSON.stringify({ ...manifest, purpose: 'Maintenance cost and public-notification comparison, same synthetic three-night fixture as continuity-host-g8FOFp. New independent model outcomes; no reroll for approval.', previousTrial: 'continuity-host-g8FOFp', maxNights: process.argv[4] === 'smoke' ? 1 : 3, questionEpisodes: 0, paidBudget: process.argv[4] === 'smoke' ? 'Final-code first-native-turn smoke: max6 isolated calls (2 generation + <=4 independent review), no repeated old jobs, not another full3night score.' : 'Max18 isolated calls (6 ORGANIZE/DEEP + <=12 per-item independent reviewers); owner max18steps/turn, all real requests counted.', expectedNotGuaranteed: 'Batch review and reload, terminal internal tools conclude via public Host control. One actual-change report per committed night; count every public text including unwanted narration.' }, null, 2));
console.log(JSON.stringify(prepared, null, 2));
