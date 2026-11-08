import type { SessionHeaderMetadata } from './sessions.js';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const idMatches = (header: SessionHeaderMetadata, prefix: string) => new RegExp(`^${prefix}${UUID}$`, 'i').test(header.id);

/** UI discovery filter only, never an authorization rule or log deletion.
 * These top-level fixtures predate subagent origin metadata. Match both the
 * exact IDs authored by this repository's live-test drivers AND their known
 * synthetic run-directory shape. A name, title or generic .tmp path alone is
 * insufficient; ordinary user forks and similarly named conversations remain. */
export function isDreamVerificationSession(header: SessionHeaderMetadata): boolean {
  if (!header.cwd || header.parentSession !== undefined || header.isSeeded === true) return false;
  const path = header.cwd.replaceAll('\\', '/');
  if (!path.startsWith('/') && !/^[A-Za-z]:\//.test(path) || path.split('/').some(part => part === '.' || part === '..')) return false;
  const location = /(?:^|\/)dsh-dream\/tests\/\.tmp\/([^/]+)(?:\/([^/]+))?\/?$/.exec(path);
  if (!location) return false;
  const [, run, child] = location;
  if (/^compaction-host-[A-Za-z0-9]{6}$/.test(run)) {
    if (child === 'auto-skip') return idMatches(header, 'dream-compact-auto-skip-');
    if (child === 'dream-compact') return idMatches(header, 'dream-compact-dream-compact-');
    return child === undefined && (idMatches(header, 'dream-native-terminal-') || idMatches(header, 'dream-compact-originals-'));
  }
  if (/^continuity-host-[A-Za-z0-9]{6}$/.test(run) && child === undefined) {
    return idMatches(header, 'dream-continuity-owner-') || idMatches(header, 'dream-continuity-originals-');
  }
  if (/^consolidation-recall-live-[A-Za-z0-9]{6}$/.test(run) && child === undefined) return idMatches(header, 'dream-consolidation-fixture-');
  if (/^(?:memory-v2-live|original-recall-live)-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/.test(run) && child === undefined) {
    return idMatches(header, run.startsWith('memory-v2-live-') ? 'dream-daily-fixture-' : 'dream-fixture-source-');
  }
  return false;
}
