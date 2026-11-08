import type { DreamConfig, Proposal } from '../types.js';

export type ChangeBudget = Pick<DreamConfig, 'maxChangeBytes' | 'maxPromotions'>;
export const DEFAULT_CHANGE_BUDGET: ChangeBudget = { maxChangeBytes: 32768, maxPromotions: 4 };
/** Count approved edit fragments, not unchanged file bytes. Never truncate a diff. */
export function assertChangeBudget(proposals: Proposal[], budget: ChangeBudget = DEFAULT_CHANGE_BUDGET) {
  const changes = proposals.filter(p => p.operation !== 'retain');
  const bytes = changes.reduce((sum, p) => sum + Buffer.byteLength(p.before) + Buffer.byteLength(p.after), 0);
  const promotions = changes.filter(p => p.consolidation?.action === 'promote').length;
  if (bytes > budget.maxChangeBytes || promotions > budget.maxPromotions) {
    throw Object.assign(new Error(`Approved batch exceeds change budget: ${bytes}/${budget.maxChangeBytes} bytes, ${promotions}/${budget.maxPromotions} promotions; defer proposals or explicitly adjust policy, never trim protected memory`), { code: 'CHANGE_BUDGET_EXCEEDED' });
  }
  return { bytes, promotions };
}
