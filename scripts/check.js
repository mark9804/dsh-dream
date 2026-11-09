import { readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
let checked = 0;
async function check(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await check(path);
    else if (entry.name.endsWith('.js')) {
      const result = spawnSync(process.execPath, ['--check', path], { stdio: 'inherit' });
      if (result.error) throw result.error;
      if (result.status !== 0) throw new Error(`Syntax check failed: ${relative(root, path)}`);
      checked++;
    }
  }
}
// TypeScript sources are checked by tsc in npm run check; JS tests/scripts
// remain syntax-checked here, including the artifact verification utilities.
for (const directory of ['tests', 'scripts', 'dev']) await check(join(root, directory));
if (!checked) throw new Error('No JavaScript files were checked');
console.log(`Syntax checked ${checked} JavaScript files.`);
