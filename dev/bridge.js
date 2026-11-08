import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, relative, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { publishGeneration, atomicJson } from '../scripts/lib/publish-generation.js';
export const inject = ['hmr', 'clientModules'];
/** Optional dev-only owner. Watches a single validated-build marker, not memory,
 * test artifacts or mutable output directories. No HTTP mutation/model tools. */
export async function apply(ctx) {
  const project = fileURLToPath(new URL('..', import.meta.url)), directory = join(project, '.dream-dev');
  await mkdir(directory, { recursive: true });
  let closed = false, completed;
  const filename = join(directory, 'pending.json');
  const atomic = (name, value) => atomicJson(join(directory, name), value);
  const process = async () => {
    if (closed) return;
    let request;
    try { request = JSON.parse(await readFile(filename, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    if (request.revision === completed) return;
    try {
      const manifestPath = resolve(request.manifest), part = relative(join(project, 'tests/.tmp'), manifestPath);
      if (!part || part === '..' || part.startsWith('../') || isAbsolute(part)) throw new Error('Build manifest must stay inside project staging');
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
      if (manifest.project !== project || manifest.revision !== request.revision || manifest.regressions !== 'passed') throw new Error('Development publication requires a fully checked generation');
      const published = await publishGeneration(project, manifest);
      const result = await ctx.hmr.reconcileProfile(['dsh-dream-settings', 'dsh-dream-configuration']);
      if (result.restartReason || result.pending.length) throw new Error('Harness reports that this generation requires a restart');
      completed = request.revision;
      await atomic('published.json', { ...published, revision: completed, hmr: 'applied', warnings: result.warnings });
    } catch (error) {
      await atomic('published.json', { state: 'failed', revision: request.revision, error: error instanceof Error ? error.message : String(error), completedAt: new Date().toISOString() });
      ctx.logger.error(error);
    }
  };
  const unwatch = await ctx.hmr.watchConfig(filename, process);
  ctx.effect(() => {
    let disposed = false;
    return async () => { if (disposed) return; disposed = true; closed = true; await unwatch(); await atomic('attached.json', { project, pid: 0, active: false }); };
  });
  await atomic('attached.json', { project, pid: globalThis.process.pid, active: true, startedAt: new Date().toISOString() });
}
