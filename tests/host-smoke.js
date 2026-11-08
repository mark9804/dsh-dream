import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { createHostFiles } from '../dist/harness/files.js';

export const inject = ['fs', 'sandboxPolicy'];
export function apply(ctx) {
  const run = async () => {
    const directory = await mkdtemp(join(process.cwd(), 'tests/.tmp/real-host-'));
    const roots = { memoryRoot: join(directory, 'memory'), stateRoot: join(directory, 'state') };
    await mkdir(roots.memoryRoot, { recursive: true });
    await mkdir(roots.stateRoot, { recursive: true });
    // No real session/model: exercise the actual Host filesystem with its
    // deployment workspace policy, not a mocked filesystem implementation.
    const files = createHostFiles(ctx, { session: undefined }, { roots });
    const checks = [];
    const path = join(roots.memoryRoot, 'synthetic.md');
    await files.write(path, 'Synthetic memory only.\n', null);
    const first = await files.read(path, { maxBytes: 100 });
    assert.equal(first.content, 'Synthetic memory only.\n'); checks.push('bounded-read');
    await assert.rejects(files.read(path, { maxBytes: 2 })); checks.push('oversize-rejected');
    await files.write(path, 'Changed synthetic text.\n', first.version);
    await assert.rejects(files.write(path, 'stale', first.version)); checks.push('stale-write-rejected');
    await assert.rejects(files.read(join(directory, 'outside.md'))); checks.push('root-fence');
    const second = createHostFiles(ctx, { session: undefined }, { roots });
    await files.withLock('test', async () => {
      const current = await files.read(path);
      await files.write(path, current.content + 'Locked update.\n', current.version);
    });
    await second.withLock('test', async () => {}); checks.push('real-lock-release-reacquire');
    await files.withGenerationLock(async () => { await files.withLock('nested', async () => {}); });
    checks.push('generation-and-state-lock');
    const report = { host: 'DSH CLI 0.2.1-rc.3', checks, directory,
      realModel: false, realAgent: false, realCompaction: false, result: 'passed' };
    await writeFile(join(directory, 'result.json'), JSON.stringify(report, null, 2));
    console.log('DSH_DREAM_HOST_SMOKE ' + JSON.stringify(report));
  };
  void run().then(() => process.exit(0), error => {
    console.error('DSH_DREAM_HOST_SMOKE_FAILED', error.stack); process.exit(1);
  });
}
