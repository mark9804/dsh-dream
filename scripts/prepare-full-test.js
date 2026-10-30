// Explicitly authorized full integration run. Creates only a fresh ignored tree.
import { lstat, readdir, mkdir, copyFile, readFile, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve, join } from 'node:path';
const root = resolve(import.meta.dirname, '..');
const run = join(root, '.dream-data/full-2026-10-27');
const old = join(root, '.dream-data/live-2026-10-27/bundle');
async function copy(from, to) {
  const s = await lstat(from);
  if (s.isSymbolicLink()) throw Error('Symlink rejected: ' + from);
  if (s.isDirectory()) {
    await mkdir(to);
    for (const n of await readdir(from)) if (n !== '.DS_Store') await copy(join(from,n),join(to,n));
  } else if (s.isFile()) await copyFile(from,to,constants.COPYFILE_EXCL);
  else throw Error('Nonregular input');
}
await mkdir(run);
await copy(join(root,'dsh-memory-backup/memory'), join(run,'memory'));
await mkdir(join(run,'state'));
await mkdir(join(run,'bundle'));
await copy(join(old,'locale'),join(run,'bundle/locale'));
await copy(join(old,'icon.svg'),join(run,'bundle/icon.svg'));
await copy(join(old,'index-stage2b.js'),join(run,'bundle/index.js'));
const name='dsh-dream-full-test';
await writeFile(join(run,'bundle/package.json'),JSON.stringify({name,version:'0.1.0',private:true,type:'module',description:'Single-session full Dream integration test on an isolated copy.',exports:{'.':'./index.js','./icon':'./icon.svg','./locale/*.json':'./locale/*.json'},files:['index.js','cordis.patch.yml','icon.svg','locale/*.json'],dsh:{bundle:{patch:'./cordis.patch.yml'}}},null,2),{flag:'wx'});
const patch=await readFile(join(old,'cordis.patch.yml'),'utf8');
await writeFile(join(run,'bundle/cordis.patch.yml'),patch.replaceAll('dsh-dream-live-test/stage2b',name).replaceAll('dsh-dream-live-test',name).replaceAll('live-2026-10-27','full-2026-10-27'),{flag:'wx'});
console.log('Prepared fresh full-run copy: '+run);
