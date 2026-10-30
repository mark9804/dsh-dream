// Explicit integration-only utility; never invoked by build/test/pack.
// Usage: node scripts/prepare-typescript-live.js /absolute/extracted/package /absolute/BasicCompaction.js SESSION_ID [auto|agent]
import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const [artifact, backend, sessionId, compactionMode = 'auto'] = process.argv.slice(2);
if (!['auto', 'agent'].includes(compactionMode)) throw new Error('Explicit auto or agent mode required');
if (!artifact || !backend || !sessionId || !isAbsolute(artifact) || !isAbsolute(backend)) throw new Error('Explicit artifact, backend and session required');
const root = resolve(import.meta.dirname, '..');
if (!resolve(artifact).startsWith(join(root, 'tests/.tmp/package-'))) throw new Error('Use verified extracted package under tests/.tmp');
const pkg = JSON.parse(await readFile(join(artifact, 'package.json'), 'utf8'));
if (pkg.exports['.'].import !== './dist/index.js') throw new Error('Compiled artifact required');
const stamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
const run = join(root, 'tests/.tmp', `typescript-live-${stamp}`);
async function copy(from, to) {
  const info = await lstat(from);
  if (info.isSymbolicLink()) throw new Error('Refuse symlink');
  if (info.isDirectory()) {
    await mkdir(to);
    for (const name of await readdir(from)) if (name !== '.DS_Store') await copy(join(from, name), join(to, name));
  } else if (info.isFile()) await copyFile(from, to, constants.COPYFILE_EXCL);
  else throw new Error('Refuse nonregular input');
}
await mkdir(run);
await mkdir(join(run, 'memory'));
for (const name of await readdir(join(root, 'dsh-memory-backup/memory'))) {
  if (name !== 'daily' && name !== '.DS_Store') await copy(join(root, 'dsh-memory-backup/memory', name), join(run, 'memory', name));
}
await mkdir(join(run, 'memory/daily'));
// Read old mapped files only. Create new aliases exclusively inside this run.
// Each original provenance note remains intact; these dates are test slots, not event dates.
const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
const part = type => parts.find(p => p.type === type).value;
const day = new Date(`${part('year')}-${part('month')}-${part('day')}T12:00:00Z`);
const baseline = ['2026-10-25', '2026-10-26', '2026-10-27'];
for (let i = 0; i < 3; i++) {
  const date = new Date(day); date.setUTCDate(day.getUTCDate() - 2 + i);
  const targetDate = date.toISOString().slice(0, 10);
  const source = await readFile(join(root, 'dsh-memory-backup/memory/daily', `${baseline[i]}.md`), 'utf8');
  // Only this fresh test tree receives calendar aliases; backup is never written.
  await writeFile(join(run, 'memory/daily', `${targetDate}.md`), source, { flag: 'wx' });
}
await mkdir(join(run, 'state'));
await mkdir(join(run, 'bundle'));
await copy(join(artifact, 'dist'), join(run, 'bundle/dist'));
await copy(join(artifact, 'icon.svg'), join(run, 'bundle/icon.svg'));
await mkdir(join(run, 'bundle/locale'));
for (const [locale, title, description] of [['en','Dream TypeScript integration test','One authorized isolated run of the verified npm artifact.'],['zh','Dream TypeScript 全流程测试','仅对新隔离副本执行一次已授权的完整流程，结束后禁用。']]) {
  await writeFile(join(run, `bundle/locale/${locale}.json`), JSON.stringify({ meta: { title, description } }), { flag: 'wx' });
}
const name = 'dsh-dream-typescript-test';
await writeFile(join(run, 'bundle/package.json'), JSON.stringify({ name, version: pkg.version, private: true, type: 'module', exports: { '.': './index.js', './icon':'./icon.svg', './locale/*.json':'./locale/*.json' }, dsh:{ bundle:{ patch:'./cordis.patch.yml' } } }, null, 2), { flag: 'wx' });
const wrapper = `import { apply as applyDream, Config } from './dist/index.js';
import BasicCompaction from ${JSON.stringify(pathToFileURL(backend).href)};
export { Config };
export const inject = ['agents'];
const child = { name: 'dream-typescript-isolated', inject: ['agents','fs','llm','tools','sandboxPolicy','compaction'], apply(ctx, config) {
  if (!config.singleRun || config.compactionMode !== ${JSON.stringify(compactionMode)} || config.personaPath) throw new Error('Isolated one-shot configuration required');
  return applyDream(ctx, config);
}};
export function apply(ctx, config) {
  return ctx.effect(() => {
    const mounted = new Map();
    function bind(agent) {
      if (agent?.id !== config.sessionId || mounted.has(agent)) return;
      const backend = agent.ctx.plugin(BasicCompaction, { auto: false });
      const engine = agent.ctx.plugin(child, config);
      mounted.set(agent, { backend, engine });
    }
    const off = ctx.on('agent/created', ({agent}) => bind(agent));
    bind(ctx.agents.get(config.sessionId));
    return async () => { off(); for (const {engine,backend} of mounted.values()) { await engine.dispose(); await backend.dispose(); } mounted.clear(); };
  });
}
`;
await writeFile(join(run, 'bundle/index.js'), wrapper, { flag: 'wx' });
const config = { sessionId, memoryRoot: join(run,'memory'), stateRoot: join(run,'state'), timeZone:'Asia/Tokyo', start:'00:00', end:'23:59', singleRun:true, compactionMode, maxProposals:4, timeoutMs:300000 };
await writeFile(join(run,'bundle/cordis.patch.yml'), `- insert:\n    - id: ${name}\n      name: ${name}\n      config: ${JSON.stringify(config)}\n`, { flag: 'wx' });
await writeFile(join(run,'provenance.json'), JSON.stringify({ artifact, version:pkg.version, sessionId, createdAt:new Date().toISOString(), baselineDiarySlots:baseline, config },null,2), { flag:'wx' });
console.log(JSON.stringify({run, bundle:join(run,'bundle'), config},null,2));
