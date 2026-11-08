import { isDeepStrictEqual } from 'node:util';
import type { OriginalBinding, OriginalReceipt, OriginalSourceVerifier, Snapshot } from '../types.js';

/** Configured links are hints, never proof; every refresh resolves them anew. */
export async function attachOriginalSources(snapshot: Snapshot, bindings: OriginalBinding[], verify?: OriginalSourceVerifier, signal?: AbortSignal): Promise<Snapshot> {
  const result = structuredClone(snapshot);
  for (const source of result.sources) delete source.originals;
  delete result.originalCoverage;
  const uncollected = new Set<string>();
  for (const binding of bindings) {
    signal?.throwIfAborted();
    const source = result.sources.find(s => s.sourceId === binding.sourceId);
    if (!source) { uncollected.add(binding.sourceId); continue; }
    let receipt: OriginalReceipt;
    if (!source.content.includes(binding.ref.quote)) receipt = { schemaVersion: 1, ref: structuredClone(binding.ref), status: 'invalid', reason: 'The linked quote is absent from the current memory source', independentEvents: 'unknown' };
    else if (!verify) receipt = { schemaVersion: 1, ref: structuredClone(binding.ref), status: 'unavailable', reason: 'Host original-source verifier unavailable', independentEvents: 'unknown' };
    else receipt = await verify(structuredClone(binding.ref), { signal });
    signal?.throwIfAborted();
    if (receipt.status === 'verified' && (!isDeepStrictEqual(receipt.ref, binding.ref) || !receipt.canonical)) throw new TypeError('Original verification returned another reference or missing canonical identity');
    source.originals ??= [];
    source.originals.push(receipt);
  }
  if (uncollected.size) result.originalCoverage = { uncollectedSourceIds: [...uncollected].sort() };
  return result;
}

/** Availability loss cannot quietly turn a failed verified dependency into raw evidence. */
export function requireOriginalEvidence(snapshot: Snapshot, evidence: { sourceId: string; quote: string }[]) {
  for (const item of evidence) {
    const source = snapshot.sources.find(s => s.sourceId === item.sourceId);
    for (const receipt of source?.originals ?? []) {
      if (receipt.status === 'verified') continue;
      // Every occurrence matters: partial overlaps must not downgrade an invalid
      // original to file-only evidence merely by extending the cited quote.
      const occurrences = (text: string) => {
        const spans: [number, number][] = [];
        if (!text) return spans;
        let index = source!.content.indexOf(text);
        while (index >= 0) { spans.push([index, index + text.length]); index = source!.content.indexOf(text, index + 1); }
        return spans;
      };
      const linked = occurrences(receipt.ref.quote), cited = occurrences(item.quote);
      if (linked.some(([a, b]) => cited.some(([c, d]) => a < d && c < b)) || receipt.ref.quote.includes(item.quote) || item.quote.includes(receipt.ref.quote)) {
        throw Object.assign(new TypeError('Cited original source is unavailable or invalid; defer the update'), { code: 'ORIGINAL_SOURCE_UNVERIFIED' });
      }
    }
  }
}
