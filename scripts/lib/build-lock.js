import assert from 'node:assert/strict';
import { mkdir, open, readFile, rename, realpath } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
/** One owner across watcher and manual builds; retired lock evidence is retained. */
export async function acquireBuildLock(project, name = 'build') {
  project = await realpath(project); const directory = join(project, '.dream-dev'); await mkdir(directory, { recursive: true });
  const filename = join(directory, name + '.lock.json'), token = randomUUID();
  let handle;
  try { handle = await open(filename, 'wx'); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    let prior; try { prior = JSON.parse(await readFile(filename, 'utf8')); } catch { throw new Error(`Unresolved ${name} lock; inspect ${filename}`); }
    try { process.kill(prior.pid, 0); throw new Error(`Another ${name} owner is active (${prior.pid})`); }
    catch (failure) {
      if (failure.code !== 'ESRCH') throw failure;
      // Never race another starter by automatically moving a stale lock. It is
      // retained for explicit inspection/recovery rather than stealing ownership.
      throw new Error(`Stale ${name} lock requires explicit recovery: ${filename}`);
    }
  }
  await handle.writeFile(JSON.stringify({ token, pid: process.pid, project, startedAt: new Date().toISOString() })); await handle.close();
  let released = false;
  return async () => {
    if (released) return; released = true;
    const value = JSON.parse(await readFile(filename, 'utf8')); assert.equal(value.token, token, 'Build lock ownership changed');
    const archived = join(directory, name + '.released-' + token + '.json');
    assert.equal(dirname(resolve(filename)), dirname(resolve(archived))); await rename(filename, archived);
  };
}
