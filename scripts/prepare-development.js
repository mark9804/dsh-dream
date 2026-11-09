import { readFile, writeFile, mkdir, copyFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { digest } from './lib/build-inputs.js';
const project = await realpath(fileURLToPath(new URL('..', import.meta.url))), target = join(project, '.dream-dev/bridge');
try { const attached = JSON.parse(await readFile(join(project, '.dream-dev/attached.json'), 'utf8')); if (attached.active === true) { try { process.kill(attached.pid, 0); throw new Error('Uninstall the running development bridge before preparing its replacement'); } catch (error) { if (error.code !== 'ESRCH') throw error; } } } catch (error) { if (error.code !== 'ENOENT') throw error; }
await mkdir(join(target, 'lib'), { recursive: true }); await mkdir(join(target, 'locale'), { recursive: true });
const inputs = ['dev/bridge.js', 'dev/package.json', 'dev/cordis.patch.yml', 'dev/icon.svg', 'dev/locale/en.json', 'dev/locale/zh.json', 'scripts/lib/publish-generation.js', 'scripts/lib/dev-publication.js', 'scripts/lib/build-inputs.js'];
const hashes = {};
for (const source of inputs) {
  const destination = source.startsWith('dev/') ? source.slice(4) : 'lib/' + source.split('/').at(-1);
  const content = await readFile(join(project, source)); hashes[source] = digest(content); await writeFile(join(target, destination), content);
}
await writeFile(join(target, 'project.json'), JSON.stringify({ project, controlHashes: hashes }, null, 2));
console.log(JSON.stringify({ runtime: join(project, '.dream-dev/runtime'), bridge: target, controlFilesFrozen: true, noGlobalHmrChanges: true }));
