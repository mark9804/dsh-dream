import { isDeepStrictEqual } from 'node:util';
import type { Agent, Execution, HostContext } from './types.js';

type RecordValue = Record<string, unknown>;
const record = (value: unknown): value is RecordValue => value !== null && typeof value === 'object' && !Array.isArray(value);
const internalPurposes = new Set(['review', 'compaction-decision', 'reload']);
interface SentTask { id: string; content: unknown; source: RecordValue; jobId: string; purpose: string; transactionId?: string }
interface TurnState { turn: number; tainted: boolean; tasks: SentTask[]; admittedSeqs: Set<number>; startSeq?: number; replacements: { compactionId: string; startSeq: number; summarySeq: number; replacementSeq: number; closed: boolean }[]; step?: number; calls?: { id: string; name: string }[]; hasPublicText?: boolean }
export interface InternalTurnCompletion {
  expect(message: unknown): void;
  finish(toolName: string, args: RecordValue, result: unknown, execution: Execution): boolean;
  dispose(): void;
}

/** Request turn completion through the public Host tool-result control. Never
 * filter generated text, reject a proposed user step, cancel an agent, or touch
 * logs. Missing hooks/control or mixed/ambiguous work fail OPEN to normal turns.
 * Only a single successful native terminal tool in our exact live internal turn
 * may conclude; sibling calls, PTC programs, user/report/other-plugin inputs do not. */
export function createInternalTurnCompletion(ctx: HostContext, agent: Agent): InternalTurnCompletion {
  const pending = new Map<string, SentTask>(); const removes: (() => void)[] = [];
  let state: TurnState | undefined, disposed = false;
  const compactions = new Map<string, { startSeq: number; turn: number | null; summarySeq?: number; shadowedSeqs?: number[]; range?: { start: number; end: number }; replaced: boolean; closed: boolean }>();
  function recognized(value: unknown): SentTask | undefined {
    if (!record(value) || typeof value.id !== 'string' || value.role !== 'user') return;
    const task = pending.get(value.id);
    return task && isDeepStrictEqual(value.content, task.content) && isDeepStrictEqual(value.source, task.source) ? task : undefined;
  }
  function shadowsLiveTask(seqs: number[]) {
    if (typeof agent.session.eventAt !== 'function') return true;
    try { for (const seq of seqs) { const event = agent.session.eventAt(seq); if (!event) return true; const data = event.data; if (event.type === 'user/message' && record(data) && typeof data.id === 'string' && pending.has(data.id)) return true; } }
    catch { return true; } // Unreadable provenance cannot authorize the optimization.
    return false;
  }
  function bookkeeping(value: unknown) { return record(value) && value.role === 'user' && record(value.source) && value.source.kind === 'runtime-context' && value.source.form === 'snapshot' && Array.isArray(value.source.sections); }
  function turnState(turn: number) { if (!state || state.turn !== turn) state = { turn, tainted: false, tasks: [], admittedSeqs: new Set(), replacements: [] }; return state; }
  if (typeof ctx.on === 'function') {
    try {
      removes.push(ctx.on('agent/inbox/claimed', payload => {
        if (disposed || payload.agent !== agent) return;
        const current = turnState(payload.turn), task = recognized(payload.message);
        if (!task) current.tainted = true;
        else if (!current.tasks.some(item => item.id === task.id)) current.tasks.push(task);
      }));
      removes.push(ctx.on('agent/pre-step', async (payload, next) => {
        if (!disposed && payload.agent === agent) {
          const current = turnState(payload.turn);
          // Independent of listener scheduling: verify every newly admitted
          // message as well as the earlier claim. Never trust source.kind alone.
          for (const message of payload.messages) {
            if (bookkeeping(message)) continue;
            const task = recognized(message);
            if (!task) current.tainted = true;
            else if (!current.tasks.some(item => item.id === task.id)) current.tasks.push(task);
          }
          current.step = payload.step; current.calls = undefined; current.hasPublicText = false;
        }
        const decision = await next();
        // A later waterfall may introduce different admitted inputs. Preserve
        // its complete decision, but withdraw our optional completion authority.
        if (!disposed && payload.agent === agent && record(decision) && decision.kind === 'enter' && Array.isArray(decision.messages)) {
          const current = turnState(payload.turn);
          for (const message of decision.messages) if (!bookkeeping(message) && !recognized(message)) current.tainted = true;
        }
        return decision;
      }));
      removes.push(ctx.on('session/event', (session, event) => {
        if (disposed || session !== agent.session || !record(event.data)) return;
        if (event.type === 'turn/start') { if (Number.isSafeInteger(event.data.turn)) turnState(event.data.turn as number).startSeq = event.seq; return; }
        if (event.type === 'turn/end') { if (state?.turn === event.data.turn) state = undefined; return; }
        if (event.type === 'compaction/start') {
          if (typeof event.data.compactionId !== 'string' || (state && state.step !== undefined) || !Number.isSafeInteger(event.seq) || (event.data.turn !== null && !Number.isSafeInteger(event.data.turn))) return;
          while (compactions.size >= 16) compactions.delete(compactions.keys().next().value!);
          compactions.set(event.data.compactionId, { startSeq: event.seq!, turn: event.data.turn as number | null, replaced: false, closed: false }); return;
        }
        if (event.type === 'compaction/summary') {
          const item = typeof event.data.compactionId === 'string' ? compactions.get(event.data.compactionId) : undefined;
          if (item && Number.isSafeInteger(event.seq) && event.seq! > item.startSeq && !item.closed && Array.isArray(event.data.shadowedSeqs) && event.data.shadowedSeqs.length && event.data.shadowedSeqs.every(seq => Number.isSafeInteger(seq) && seq >= 0)) { item.summarySeq = event.seq; item.shadowedSeqs = [...event.data.shadowedSeqs] as number[]; const range = event.data.shadowedRange; if (record(range) && Number.isSafeInteger(range.start) && Number.isSafeInteger(range.end)) item.range = { start: range.start as number, end: range.end as number }; }
          return;
        }
        if (event.type === 'compaction/end') {
          const item = typeof event.data.compactionId === 'string' ? compactions.get(event.data.compactionId) : undefined;
          if (item && !item.closed && Number.isSafeInteger(event.seq)) {
            item.closed = true;
            for (const replacement of state?.replacements ?? []) if (replacement.compactionId === event.data.compactionId) {
              replacement.closed = !Object.hasOwn(event.data, 'error') && event.data.turn === state!.turn && event.seq! === replacement.replacementSeq + 1;
              if (!replacement.closed && state) state.tainted = true;
            }
          }
          return;
        }
        if (event.type === 'tool/result' && state && event.data.turn === state.turn && record(event.data.message) && event.data.message.isError === true) { state.tainted = true; return; }
        if (event.type === 'user/message' && state) {
          // Runtime snapshots are Host bookkeeping, not internal-task authority.
          // Every other admitted input must be one exact message we sent.
          const task = recognized(event.data);
          if (task) { if (Number.isSafeInteger(event.seq)) state.admittedSeqs.add(event.seq!); return; }
          if (bookkeeping(event.data)) return;
          const source = event.data.source, op = event.surfaceOp;
          const compact = record(source) && source.kind === 'compact-checkpoint' && typeof source.compactionId === 'string' ? compactions.get(source.compactionId) : undefined;
          const replacesHistory = event.data.role === 'user' && typeof event.data.id === 'string' && !pending.has(event.data.id) && compact && !compact.closed && !compact.replaced && compact.summarySeq !== undefined && compact.turn === state.turn && Number.isSafeInteger(event.seq) && event.seq! === compact.summarySeq + 1
            && record(op) && op.op === 'replace' && Number.isSafeInteger(op.startSeq) && Number.isSafeInteger(op.endSeq) && (op.startSeq as number) >= 0 && (op.endSeq as number) >= 0 && (op.startSeq as number) < compact.startSeq && (op.endSeq as number) < compact.startSeq
            && Array.isArray(event.sourceEventSeqs) && event.sourceEventSeqs.includes(compact.startSeq) && event.sourceEventSeqs.includes(compact.summarySeq)
            && compact.range !== undefined && compact.range.start === op.startSeq && compact.range.end === op.endSeq
            && state.startSeq !== undefined && compact.shadowedSeqs?.length && compact.shadowedSeqs[0] === op.startSeq && compact.shadowedSeqs.at(-1) === op.endSeq && new Set(compact.shadowedSeqs).size === compact.shadowedSeqs.length && compact.shadowedSeqs.every(seq => seq < state!.startSeq! && !state!.admittedSeqs.has(seq))
            && !shadowsLiveTask(compact.shadowedSeqs) && isDeepStrictEqual(event.sourceEventSeqs, [compact.startSeq, compact.summarySeq, ...compact.shadowedSeqs]);
          if (replacesHistory) {
            // A Host-bracketed replacement of PRIOR surface history is not a new
            // request. It never supplies task identity or approval: an exact live
            // notification must still be admitted and the native terminal succeed.
            compact.replaced = true;
            state.replacements.push({ compactionId: (source as RecordValue).compactionId as string, startSeq: compact.startSeq, summarySeq: compact.summarySeq!, replacementSeq: event.seq!, closed: false });
          } else state.tainted = true;
          return;
        }
        if (event.type !== 'assistant/message') return;
        const data = event.data;
        if (!state || data.turn !== state.turn || data.step !== state.step || !record(data.message) || !Array.isArray(data.message.content)) return;
        const blocks = data.message.content;
        if (state.calls !== undefined) { state.tainted = true; return; }
        state.calls = [];
        for (const block of blocks) {
          if (!record(block)) { state.tainted = true; continue; }
          if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) { state.hasPublicText = true; state.tainted = true; }
          if (block.type === 'tool-call') {
            if (typeof block.id !== 'string' || typeof block.name !== 'string') state.tainted = true;
            else {
              state.calls.push({ id: block.id, name: block.name });
              if (!['dream_status', 'dream_review_batch', 'dream_reload_read', 'dream_decide_compaction', 'dream_ack_reload'].includes(block.name)) state.tainted = true;
            }
          }
        }
        if (state.calls.length > 1) state.tainted = true;
      }));
    } catch {
      // Older Hosts keep ordinary behavior; partially installed observations must
      // never authorize completion. Nothing is silently suppressed as fallback.
      for (const remove of removes.splice(0).reverse()) remove();
    }
  }
  return {
    expect(message) {
      if (disposed || !record(message) || typeof message.id !== 'string' || !record(message.source) || message.role !== 'user') return;
      const source = message.source;
      if (source.kind !== 'dsh-dream' || typeof source.purpose !== 'string' || !internalPurposes.has(source.purpose) || typeof source.jobId !== 'string') return;
      while (pending.size >= 64) pending.delete(pending.keys().next().value!);
      pending.set(message.id, { id: message.id, content: structuredClone(message.content), source: structuredClone(source), purpose: source.purpose, jobId: source.jobId, ...(typeof source.transactionId === 'string' ? { transactionId: source.transactionId } : {}) });
    },
    finish(toolName, args, result, execution) {
      if (disposed || removes.length !== 3 || !state || state.tainted || state.replacements.some(item => !item.closed) || state.hasPublicText || state.tasks.length !== 1 || state.calls?.length !== 1
        || execution.agent !== agent || execution.parent !== undefined || typeof execution.concludeTurn !== 'function' || execution.signal?.aborted
        || state.calls[0].id !== execution.callId || state.calls[0].name !== toolName || !record(result)) return false;
      const task = state.tasks[0]; if (task.jobId !== args.jobId) return false;
      let terminal = false;
      if (task.purpose === 'review' && toolName === 'dream_review_batch') terminal = Array.isArray(result.remainingUnreviewedIds) && result.remainingUnreviewedIds.length === 0 && Array.isArray(result.results) && result.results.length > 0;
      if (task.purpose === 'compaction-decision' && toolName === 'dream_decide_compaction') terminal = task.transactionId === args.transactionId && result.execution === 'after_agent_idle' && (result.decision === 'compact' || result.decision === 'skip');
      if (task.purpose === 'reload' && toolName === 'dream_ack_reload') terminal = task.transactionId === args.transactionId && result.acknowledged === true && record(result.report) && result.report.state === 'sent';
      if (!terminal) return false;
      execution.concludeTurn();
      pending.delete(task.id); state.tainted = true;
      return true;
    },
    dispose() { if (disposed) return; disposed = true; for (const remove of removes.splice(0).reverse()) remove(); pending.clear(); compactions.clear(); state = undefined; },
  };
}
