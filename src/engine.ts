import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { applyProposal, validateChangeSet, validateProposal, validateSnapshot } from './domain/contracts.js';
import { transition, TERMINAL_STATES } from './domain/state-machine.js';
import { eligibleProposals, latestReview, recordReview, reviewMatches, wasRejected } from './review/index.js';
import { collectSnapshot, inputFingerprint, protectedText, sourcePath } from './dream/materials.js';
import { inRestWindow, localDate, recentDates } from './scheduler/window.js';

import type { Job, Snapshot, DreamConfig, Scope, Files, Generate, HostControl, Change, ChangeSet, DeliveryField, Delivery, Actor, ReviewRequest, CleanReviewer, State, DreamResult, CompactionInput, ContextPressure } from './types.js';
import { errorFields } from './types.js';
import type { createStore } from './storage/index.js';
import type { TransitionOptions } from './domain/state-machine.js';
// State-specific non-null assertions below reflect existing transition/record checks;
// they do not grant approval or bypass runtime validation of recovered records.
interface EngineOptions { config: DreamConfig; scope: Scope; files: Files; store: ReturnType<typeof createStore>; generate: Generate; cleanReview?: CleanReviewer; host: HostControl; signal?: AbortSignal; now?: () => Date; id?: () => string; generationLock?: <T>(operation: () => Promise<T>) => Promise<T> }
type DreamOutcome = Job | { jobId: string; waiting: string } | { skipped: boolean; reason: string } | { reused: boolean; jobId: string; state: State; reason?: string };
interface DeliveryOptions { retry?: boolean; renew?: boolean }

function changedMaterial(snapshot: Snapshot, previous: Snapshot | undefined, timeZone: string) {
  if (!previous) return true;
  const old = new Map(previous.sources.map(s => [s.sourceId, s]));
  const current = new Map(snapshot.sources.map(s => [s.sourceId, s]));
  if (snapshot.sources.some(s => !old.has(s.sourceId) || s.content !== old.get(s.sourceId)!.content)) return true;
  const dates = new Set(recentDates(new Date(snapshot.capturedAt), timeZone));
  return previous.sources.some(s => !current.has(s.sourceId) &&
    (s.role !== 'daily' || [...dates].some(date => s.path.endsWith(`${date}.md`) || s.path.endsWith(`${date.slice(2)}.md`))));
}

function changeSet(job: Job, transactionId: string) {
  const ids = job.committingProposalIds!; // Prepared transition has fixed this subset.
  const changes = new Map<string, Change>();
  for (const id of ids) {
    const proposal = job.proposals.find(p => p.proposalId === id)!;
    const target = job.snapshot.sources.find(s => s.sourceId === proposal.targetId)!;
    const change = changes.get(target.sourceId) ?? { targetId: target.sourceId, before: target.content, after: target.content, version: target.version };
    change.after = applyProposal(change.after, proposal);
    changes.set(target.sourceId, change);
    if (proposal.operation === 'archive') changes.set(`archive:${id}`, { targetId: `archive:${id}`, before: '', after: proposal.before, version: null });
  }
  return validateChangeSet({ schemaVersion: 1, transactionId, jobId: job.jobId,
    proposalIds: ids, reviewIds: ids.map(id => latestReview(job, id)!.reviewId),
    status: 'prepared', changes: [...changes.values()] }, job);
}

/** Complete workflow over replaceable Host, clock, model, and storage boundaries. */
export function createEngine({ config, scope, files, store, generate, cleanReview, host, signal,
  now = () => new Date(), id = randomUUID, generationLock = operation => operation() }: EngineOptions) {
  const tasks = new Map<string, Promise<void>>();
  let chain = Promise.resolve();
  let generating: Promise<DreamOutcome> | undefined;
  const time = () => now().toISOString();
  const checkScope = (job: Job) => {
    if (!isDeepStrictEqual(job.scope, scope)) throw new Error('Job belongs to another agent or memory scope');
    return job;
  };
  const get = async (jobId: string) => {
    const job = await store.loadJob(jobId);
    if (!job) throw new Error('Unknown dream job');
    return checkScope(job);
  };
  const update = (jobId: string, fn: (job: Job) => Job | Promise<Job>) => store.updateJob(jobId, job => fn(checkScope(job)));
  const move = (jobId: string, state: State, extra: TransitionOptions = {}) => update(jobId, job => transition(job, state, { now: time(), ...extra }));
  const deliveryFields: DeliveryField[] = ['reviewDelivery', 'reloadDelivery', 'reportDelivery', 'attentionDelivery', 'compactionPauseDelivery', 'compactionDecisionDelivery'];
  const deliveries = (job: Job) => Object.fromEntries(deliveryFields.filter(field => job[field]).map(field => [field, {
    ...job[field], requiresInspection: ['queued', 'uncertain'].includes(job[field]!.state),
  }]));
  const unresolved = (job: Job) => job.proposals.some(proposal => !job.appliedProposalIds.includes(proposal.proposalId) && latestReview(job, proposal.proposalId)?.decision !== 'reject');

  function resolveTarget(job: Job, targetId: string) {
    const source = job.snapshot.sources.find(s => s.sourceId === targetId);
    if (source) return sourcePath(config, source);
    if (targetId.startsWith('archive:')) {
      const proposalId = targetId.slice(8);
      if (job.proposals.some(p => p.proposalId === proposalId && p.operation === 'archive')) {
        return join(config.memoryRoot, 'archive', encodeURIComponent(job.jobId), `${encodeURIComponent(proposalId)}.md`);
      }
    }
    throw new Error('Unknown allowed target');
  }

  async function refreshed(snapshot: Snapshot) {
    const sources = [];
    let totalBytes = 0;
    for (const source of snapshot.sources) {
      const current = await files.read(sourcePath(config, source), { maxBytes: Math.min(config.maxSourceBytes, config.maxInputBytes - totalBytes) });
      if (current) {
        const bytes = Buffer.byteLength(current.content);
        totalBytes += bytes;
        if (bytes > config.maxSourceBytes || totalBytes > config.maxInputBytes) throw new Error('Material budget exceeded during review refresh');
      }
      if (!current) throw new Error(`Original source is missing: ${source.path}`);
      sources.push({ ...source, ...current, protectedText: protectedText(current.content, source.role) });
    }
    return validateSnapshot({ ...snapshot, snapshotId: id(), capturedAt: time(), sources });
  }

  async function delivery(jobId: string, field: DeliveryField, send: (messageId: string) => Promise<unknown>, { retry = false, renew = false }: DeliveryOptions = {}): Promise<Delivery> {
    let attempt: Delivery | undefined;
    let job = await update(jobId, job => {
      const previous = job[field];
      if (previous && ((!retry && !renew) || (previous.state === 'sent' && !renew))) return job;
      const { history = [], ...last } = previous ?? {} as Delivery; // last is only used when previous exists.
      attempt = { messageId: id(), state: 'queued', at: time(),
        history: previous ? [...history, { ...last, state: last.state === 'queued' ? 'uncertain' : last.state }] : [] };
      return { ...job, [field]: attempt };
    });
    if (!attempt) return job[field]!;
    let outcome: Delivery;
    try {
      await send(attempt.messageId);
      outcome = { ...attempt, state: 'sent', sentAt: time() };
    } catch (error) {
      outcome = { ...attempt, state: errorFields(error).code === 'UNAVAILABLE' ? 'failed' : 'uncertain',
        error: { code: errorFields(error).code ?? 'DELIVERY_UNCERTAIN', message: errorFields(error).message! } };
    }
    job = await update(jobId, current => ({ ...current, [field]: outcome }));
    return job[field]!;
  }

  async function needsAttention(jobId: string, message: string) {
    if (signal?.aborted) return;
    await delivery(jobId, 'attentionDelivery', messageId => host.notify(
      `DSH-Dream 需要处理：${message}。任务 ${jobId}。请先用 dream_status 查看状态，再向用户简要说明需要处理的问题；不要重复已完成的记忆应用。`, { messageId, jobId }));
  }

  async function fail(jobId: string, error: unknown) {
    const job = await get(jobId);
    const cancelled = signal?.aborted || errorFields(error).code === 'REST_WINDOW_ENDED';
    if (!TERMINAL_STATES.includes(job.state) && !['failed', 'cancelled'].includes(job.state)) {
      await update(jobId, current => ({ ...transition(current, cancelled ? 'cancelled' : 'failed', {
        now: time(), phase: current.state,
        checkpoint: { state: current.state, transactionId: current.transaction?.transactionId },
      }), error: { code: errorFields(error).code ?? 'FAILED', message: errorFields(error).message! } }));
    }
    if (!cancelled) await needsAttention(jobId, errorFields(error).message!);
    (error as { dreamHandled: boolean }).dreamHandled = true; // Preserve the original thrown object's handled marker.
  }

  function queue(jobId: string, work: () => Promise<unknown>) {
    if (tasks.has(jobId)) return;
    const task = chain.then(async () => {
      signal?.throwIfAborted();
      await host.waitForIdle(signal);
      await work();
    }).catch(error => fail(jobId, error)).finally(() => tasks.delete(jobId));
    tasks.set(jobId, task);
    chain = task.catch(() => {});
  }

  async function requestReview(job: Job, options?: DeliveryOptions) {
    const result = await delivery(job.jobId, 'reviewDelivery', messageId => host.requestReview(
      `这是插件内部醒来审核任务，不要汇报审核过程。先调用 dream_status({jobId:${JSON.stringify(job.jobId)}})，对每个待审提案调用 dream_review，decision=review：插件会重新读取原始资料，在不含本会话历史、梦境或生成者理由的独立模型请求中审核；只有该请求可以批准。你可以直接reject/defer，但不能直接accept，也不能把梦境当证据或给独立审核传递审批理由。已reject项不得反复重审凑批准。审核完成后结束本轮；插件会在你空闲时提交独立审核accept项，defer保留。`,
      { messageId, jobId: job.jobId }), options);
    if (result.state !== 'sent') await needsAttention(job.jobId, '审核请求的送达结果未确认；检查投递状态后可显式重试');
    return result;
  }

  async function generateJob(job: Job, activeSignal?: AbortSignal): Promise<Job> {
    activeSignal?.throwIfAborted();
    let result = await store.loadDreamResult(job.jobId);
    const persisted = result !== null;
    if (!persisted) {
      if (!inRestWindow(now(), config)) throw Object.assign(new Error('Dream generation is outside the rest window'), { code: 'REST_WINDOW_ENDED' });
      result = await generate(job.snapshot, job.jobId, { signal: activeSignal });
      activeSignal?.throwIfAborted();
      if (!inRestWindow(now(), config)) throw Object.assign(new Error('Rest window ended before generation completed'), { code: 'REST_WINDOW_ENDED' });
      result = { ...result, dreamDate: localDate(now(), config.timeZone) };
    }
    // A missing persisted result is assigned by generate above.
    const generated = result!;
    if (typeof generated.dream !== 'string' || !generated.dream.trim() || !Array.isArray(generated.proposals)) throw new TypeError('Invalid generator result');
    for (const proposal of generated.proposals) {
      validateProposal(proposal, job.snapshot);
      if (proposal.jobId !== job.jobId) throw new TypeError('Generator returned another job identity');
    }
    if (!persisted) await store.saveDreamResult(job.jobId, generated);
    const rejections = (await store.listRejected()).map(r => r.review);
    const proposals = generated.proposals.filter(proposal => !wasRejected(proposal, job.snapshot, rejections));
    const sensitive = job.snapshot.sources.some(s => s.sensitivity === 'sensitive');
    const dreamPath = await store.appendDream({ jobId: job.jobId, date: generated.dreamDate ?? localDate(new Date(job.createdAt), config.timeZone),
      text: `${sensitive ? '<!-- sensitive -->\n' : ''}${generated.dream}` });
    job = await update(job.jobId, current => ({ ...transition(current, 'awaiting_review', { now: time() }), proposals, dreamPath }));
    if (!proposals.length) return move(job.jobId, 'reviewed_no_changes');
    await requestReview(job);
    return get(job.jobId);
  }

  async function continueEarly(job: Job, activeSignal?: AbortSignal): Promise<DreamOutcome> {
    activeSignal?.throwIfAborted();
    if (!inRestWindow(now(), config)) return { jobId: job.jobId, waiting: 'rest_window' };
    if (['failed', 'cancelled'].includes(job.state)) job = await move(job.jobId, job.phase!);
    if (job.state === 'queued') job = await move(job.jobId, 'collecting');
    if (job.state !== 'collecting') return job;
    try {
      const snapshot = await collectSnapshot(files, config, scope, { now: now(), snapshotId: id() });
      activeSignal?.throwIfAborted();
      job = await update(job.jobId, current => ({ ...transition(current, 'generating', { now: time() }),
        snapshot, inputFingerprint: inputFingerprint(snapshot) }));
      return await generateJob(job, activeSignal);
    } catch (error) { await fail(job.jobId, error); throw error; }
  }

  async function dream({ signal: generationSignal }: { signal?: AbortSignal } = {}): Promise<DreamOutcome> {
    if (generating) return generating;
    const activeSignal = signal && generationSignal ? AbortSignal.any([signal, generationSignal]) : signal ?? generationSignal;
    generating = generationLock(async () => {
      activeSignal?.throwIfAborted();
      if (!inRestWindow(now(), config)) return { skipped: true, reason: 'outside_rest_window' };
      // shortcut: history lookup is linear; add a compact progress index if measured history reads become costly.
      const jobs = (await store.listJobs()).filter(job => isDeepStrictEqual(job.scope, scope));
      // An interrupted pre-generation job owns no model result or review. Reuse its
      // identity even if material changed while the Host was down.
      const early = jobs.find(job => ['queued', 'collecting'].includes(job.state) ||
        (['failed', 'cancelled'].includes(job.state) && ['queued', 'collecting'].includes(job.phase!)));
      if (early) return continueEarly(early, activeSignal);
      const existing = jobs.at(-1);
      if (config.singleRun && existing && !(existing.state === 'cancelled' && existing.phase === 'generating' && existing.error?.code === 'REST_WINDOW_ENDED')) {
        return { reused: true, jobId: existing.jobId, state: existing.state, reason: 'single_run' };
      }
      const snapshot = await collectSnapshot(files, config, scope, { now: now(), snapshotId: id() });
      const fingerprint = inputFingerprint(snapshot);
      const same = jobs.findLast(job => job.inputFingerprint === fingerprint || job.processedFingerprint === fingerprint);
      if (same) {
        if (same.state === 'cancelled' && same.phase === 'generating' && same.error?.code === 'REST_WINDOW_ENDED') {
          const job = await move(same.jobId, 'generating');
          try { return await generateJob(job, activeSignal); }
          catch (error) { await fail(job.jobId, error); throw error; }
        }
        return { reused: true, jobId: same.jobId, state: same.state };
      }
      const last = jobs.toSorted((a, b) => a.createdAt.localeCompare(b.createdAt)).at(-1);
      if (config.singleRun && last) return { reused: true, jobId: last.jobId, state: last.state, reason: 'single_run' };
      if (last && !changedMaterial(snapshot, last.processedSnapshot ?? last.snapshot, config.timeZone)) return { skipped: true, reason: 'no_new_material' };
      const timestamp = time();
      let job: Job = { schemaVersion: 1, jobId: id(), scope: structuredClone(scope), snapshot,
        state: 'queued', proposals: [], reviews: [], appliedProposalIds: [], createdAt: timestamp, updatedAt: timestamp, inputFingerprint: fingerprint };
      await store.saveJob(job);
      await move(job.jobId, 'collecting');
      job = await move(job.jobId, 'generating');
      try { return await generateJob(job, activeSignal); }
      catch (error) { await fail(job.jobId, error); throw error; }
    }).finally(() => { generating = undefined; });
    return generating;
  }

  function contextPressure(): ContextPressure {
    try { return host.contextPressure?.() ?? { unavailableReason: 'Host context measurement unavailable' }; }
    catch { return { unavailableReason: 'Host context measurement failed' }; }
  }

  async function requestCompactionDecision(job: Job, options?: DeliveryOptions) {
    const result = await delivery(job.jobId, 'compactionDecisionDelivery', messageId => host.requestReview(
      `这是插件内部压缩决策任务，记忆已提交，不要重新应用或汇报中间状态。先调用 dream_status({jobId:${JSON.stringify(job.jobId)}}) 获取当前 contextPressure，再按上下文用量、窗口上限及后续重读所需空间决定 compact 或 skip。数字是宿主估算，不是精确用量；指标缺失时不得编造比例，可保守选择 compact。调用 dream_decide_compaction，jobId=${JSON.stringify(job.jobId)}，transactionId=${JSON.stringify(job.transaction!.transactionId)}，并给出简短理由。选择后结束本轮，空闲时执行；两条路径都必须实际重读并回执。`,
      { messageId, jobId: job.jobId, transactionId: job.transaction!.transactionId }), options);
    if (result.state !== 'sent') await needsAttention(job.jobId, '压缩决策请求的送达结果未确认；检查状态后可显式重试，不要重复已提交记忆');
    return result;
  }

  async function decideCompaction(args: CompactionInput, { actor }: { actor: Actor }) {
    if (config.compactionMode !== 'agent') throw new Error('Compaction decision requires agent mode');
    if (actor?.agentId !== scope.agentId || actor.sessionId !== scope.sessionId) throw new Error('Compaction actor does not match scope');
    if (!['compact', 'skip'].includes(args.decision) || typeof args.reason !== 'string' || !args.reason.trim() || args.reason.length > 4096) throw new TypeError('Invalid compaction decision');
    await update(args.jobId, job => {
      if (job.transaction?.transactionId !== args.transactionId) throw new Error('Compaction decision belongs to another transaction');
      if (job.compactionChoice) {
        if (job.compactionChoice.decision !== args.decision) throw new Error('Compaction decision already recorded');
        return job;
      }
      if (job.state !== 'awaiting_compaction') throw new Error('Job is not awaiting a compaction decision');
      return { ...job, compactionChoice: { transactionId: args.transactionId, decision: args.decision, reason: args.reason,
        actor: { ...actor }, at: time(), pressure: contextPressure() } };
    });
    submit({ jobId: args.jobId });
    return { jobId: args.jobId, decision: args.decision, execution: 'after_agent_idle' };
  }

  async function afterCommit(jobId: string) {
    let job = await get(jobId);
    if (job.state === 'applied') job = await update(jobId, current => ({
      ...transition(current, 'awaiting_compaction', { now: time() }), recovery: undefined,
    }));
    // Configuration, not a submit/retry argument, owns this boundary. Every
    // post-commit entry (including recovery) must pass it before compacting.
    if (job.state === 'awaiting_compaction' && config.compactionMode === 'manual') {
      await delivery(jobId, 'compactionPauseDelivery', messageId => host.notify(
        `本批记忆更新已提交；压缩阶段已暂停（compactionMode=manual），尚未压缩或安排重读。任务 ${jobId}。请向用户简要通知一次；不要调用 submit/retry 试图解除暂停。只有用户以后明确将配置改为 auto 或 agent 才允许继续第二阶段。`,
        { messageId, jobId, transactionId: job.transaction?.transactionId }));
      return;
    }
    if (job.state === 'awaiting_compaction' && config.compactionMode === 'agent') {
      if (!job.compactionChoice) { await requestCompactionDecision(job); return; }
      if (job.compactionChoice.decision === 'skip') {
        await update(jobId, current => ({ ...transition(current, 'awaiting_reload', { now: time() }),
          compaction: { status: 'skipped' }, reload: { transactionId: current.transaction!.transactionId, status: 'preparing' } }));
        await prepareReload(jobId);
        return;
      }
    }
    if (job.state !== 'awaiting_compaction' || (job.compactionAttempts ?? 0) >= 3) return;
    job = await update(jobId, current => ({ ...transition(current, 'compacting', { now: time() }), compactionAttempts: (current.compactionAttempts ?? 0) + 1 }));
    let result;
    try { result = await host.compact(signal); }
    catch (error) {
      if (errorFields(error).code === 'busy') {
        job = await move(jobId, 'awaiting_compaction');
        if (job.compactionAttempts! >= 3) await needsAttention(jobId, '记忆已提交，压缩连续忙碌；后续只需重试压缩');
        return;
      }
      throw error;
    }
    await update(jobId, currentJob => ({ ...transition(currentJob, 'awaiting_reload', { now: time() }),
      compaction: result === null ? { status: 'no_op' } : { status: 'completed', compactionId: result.compactionId },
      reload: { transactionId: currentJob.transaction!.transactionId, status: 'preparing' },
    }));
    await prepareReload(jobId);
  }

  async function prepareReload(jobId: string, { retry = false } = {}) {
    const before = await get(jobId);
    if (before.reloadDelivery && !retry) return before.reloadDelivery;
    const current = await collectSnapshot(files, config, scope, { now: now(), snapshotId: id() });
    const reloadSources = current.sources.filter(s => ['longTerm', 'decisions', 'journal', 'daily', 'persona'].includes(s.role))
      .map(s => ({ sourceId: s.sourceId, path: sourcePath(config, s), version: s.version, content: s.content }));
    const renew = retry && before.reloadDelivery?.state === 'sent' && !isDeepStrictEqual(before.reload?.sources, reloadSources);
    if (before.reloadDelivery?.state === 'sent' && !renew) return before.reloadDelivery;
    const job = await update(jobId, currentJob => ({ ...currentJob,
      reload: { transactionId: currentJob.transaction!.transactionId, status: 'ready', sources: reloadSources },
    }));
    const result = await delivery(jobId, 'reloadDelivery', messageId => host.requestReload(
      `这是插件内部重读任务。记忆变更已提交，${job.compaction!.status === 'skipped' ? '本轮已选择跳过压缩，未执行压缩' : job.compaction!.status === 'no_op' ? '宿主本次没有可压缩范围' : '宿主已完成压缩'}。不要汇报中间状态。请实际读取以下长期/中期记忆、人格及最近三天日记，然后调用 dream_ack_reload({jobId:${JSON.stringify(jobId)},transactionId:${JSON.stringify(job.reload!.transactionId)},readSourceIds:[已实际读完的全部sourceId]})。不得把收到提示当作已读完。资料：${JSON.stringify(reloadSources.map(({ sourceId, path }) => ({ sourceId, path })))}`,
      { messageId, jobId, transactionId: job.reload!.transactionId }), { retry, renew });
    if (result.state !== 'sent') await needsAttention(jobId, '重读请求的送达结果未确认；检查后可显式重试，已提交记忆无需重写');
    return result;
  }

  async function submitNow(jobId: string) {
    let job = await get(jobId);
    if (job.reload?.acknowledgedAt && job.reportDelivery?.state !== 'sent') return;
    if (['applied', 'awaiting_compaction'].includes(job.state)) return afterCommit(jobId);
    if (!['awaiting_review', 'prepared', 'applying'].includes(job.state)) return;
    if (job.state === 'awaiting_review') {
      if (!eligibleProposals(job).length) {
        if (!unresolved(job)) await move(jobId, job.appliedProposalIds.length ? 'completed' : 'reviewed_no_changes');
        return;
      }
      job = await move(jobId, 'prepared');
    }
    if (job.state === 'prepared') {
      const transaction = changeSet(job, id());
      job = await update(jobId, current => ({ ...transition(current, 'applying', { now: time() }), transaction,
        compactionAttempts: 0, compaction: undefined, compactionChoice: undefined, compactionDecisionDelivery: undefined, compactionPauseDelivery: undefined, reload: undefined, reloadDelivery: undefined, reportDelivery: undefined, attentionDelivery: undefined }));
    }
    const commit = (maintenanceSignal: AbortSignal) => store.commit(job.transaction!, targetId => resolveTarget(job, targetId),
      { afterStep: () => maintenanceSignal?.throwIfAborted() });
    await host.maintain(commit, signal);
    await update(jobId, current => {
      const sources = current.snapshot.sources.map(source => {
        const change = current.transaction!.changes.find(c => c.targetId === source.sourceId);
        return change ? { ...source, content: change.after, protectedText: protectedText(change.after, source.role) } : source;
      });
      const processedSnapshot = { ...current.snapshot, sources };
      return { ...current, recovery: undefined, processedSnapshot, processedFingerprint: inputFingerprint(processedSnapshot) };
    });
    await afterCommit(jobId);
  }

  function submit({ jobId }: { jobId: string }) {
    queue(jobId, () => submitNow(jobId));
    return { jobId, queued: true };
  }

  const reviewTasks = new Map<string, Promise<unknown>>();
  const pendingReviews = new Set<Promise<unknown>>();
  async function review(args: ReviewRequest, { actor, signal: requestSignal }: { actor: Actor; signal?: AbortSignal }) {
    if (actor?.agentId !== scope.agentId || actor.sessionId !== scope.sessionId) throw new Error('Review actor does not match scope');
    if (!['review', 'reject', 'defer'].includes(args.decision)) throw new TypeError('Direct accept is forbidden; request an isolated review');
    const key = `${args.jobId}/${args.proposalId}`;
    if (args.decision === 'review' && reviewTasks.has(key)) throw new Error('Isolated review is already running');
    const work = (async () => {
      const before = await get(args.jobId);
      const proposal = before.proposals.find(p => p.proposalId === args.proposalId);
      if (!proposal) throw new TypeError('unknown proposal');
      if (before.appliedProposalIds.includes(args.proposalId) || !['awaiting_review', 'prepared'].includes(before.state)) throw new Error('Proposal is not open for review');
      if (args.decision === 'review' && before.reviews.some(r => r.proposalId === args.proposalId && r.decision === 'reject' && isDeepStrictEqual(r.proposalSnapshot, proposal))) {
        throw new Error('Rejected proposals cannot be rerolled for approval');
      }
      const activeSignal = AbortSignal.any([signal, requestSignal].filter((s): s is AbortSignal => !!s));
      activeSignal.throwIfAborted();
      // Capture authoritative inputs before inference. Never hold the storage lock
      // while a model runs, and never forward the chat's reason to that model.
      const snapshot = args.decision === 'review' ? await refreshed(before.snapshot) : before.snapshot;
      if (args.decision === 'review') validateProposal(proposal, snapshot);
      if (args.decision === 'review' && !cleanReview) throw Object.assign(new Error('Isolated reviewer unavailable; no approval granted'), { code: 'CLEAN_REVIEW_REQUIRED' });
      const result = args.decision === 'review'
        ? await cleanReview!(structuredClone(snapshot), structuredClone(proposal), { signal: activeSignal })
        : { decision: args.decision, reason: args.reason, authority: undefined };
      activeSignal.throwIfAborted();
      const job = await update(args.jobId, async current => {
        activeSignal.throwIfAborted();
        if (!isDeepStrictEqual(current.proposals, before.proposals) || !isDeepStrictEqual(current.reviews, before.reviews) || !isDeepStrictEqual(current.snapshot, before.snapshot) || current.state !== before.state) {
          throw Object.assign(new Error('Review inputs or decisions changed during isolated review'), { code: 'STALE_REVIEW' });
        }
        if (args.decision === 'review') {
          const fresh = await refreshed(snapshot);
          if (!isDeepStrictEqual(fresh.sources, snapshot.sources)) throw Object.assign(new Error('Source changed during isolated review; no approval granted'), { code: 'STALE_REVIEW' });
        }
        return recordReview({ ...current, snapshot }, { jobId: args.jobId, proposalId: args.proposalId, decision: result.decision, reason: result.reason }, actor,
          { reviewId: id(), now: time(), authority: result.authority });
      });
      if (result.decision === 'reject') await store.appendRejected({ review: latestReview(job, args.proposalId)!, proposal: job.proposals.find(p => p.proposalId === args.proposalId)! });
      submit({ jobId: job.jobId });
      return { jobId: job.jobId, proposalId: args.proposalId, decision: result.decision, reason: result.reason, authority: result.authority, submission: 'after_agent_idle' };
    })();
    pendingReviews.add(work);
    if (args.decision === 'review') reviewTasks.set(key, work);
    try { return await work; } finally { pendingReviews.delete(work); if (reviewTasks.get(key) === work) reviewTasks.delete(key); }
  }

  async function ackReload({ jobId, transactionId, readSourceIds }: { jobId: string; transactionId: string; readSourceIds: string[] }, { actor }: { actor: Actor }) {
    let job = await get(jobId);
    if (actor?.agentId !== scope.agentId || actor.sessionId !== scope.sessionId) throw new Error('Reload actor does not match scope');
    if (job.reload?.transactionId !== transactionId) throw new Error('Reload receipt belongs to another transaction');
    if (job.reload.acknowledgedAt) {
      const report = await reportChanges(job, { retry: job.reportDelivery?.state === 'failed' });
      return { jobId, acknowledged: true, state: job.state, report };
    }
    if (job.state !== 'awaiting_reload' || job.reload.status !== 'ready' || new Set(readSourceIds).size !== readSourceIds.length ||
      readSourceIds.length !== job.reload.sources!.length || job.reload.sources!.some(s => !readSourceIds.includes(s.sourceId))) throw new Error('Reload receipt is incomplete');
    for (const source of job.reload.sources!) {
      const current = await files.read(source.path);
      if (!current || current.content !== source.content || !isDeepStrictEqual(current.version, source.version)) throw new Error('Memory changed during reload; a new read is required');
    }
    const pending = unresolved(job);
    job = await update(jobId, current => ({ ...transition(current, pending ? 'awaiting_review' : 'completed', { now: time() }),
      reload: { ...current.reload!, acknowledgedAt: time() } }));
    const report = await reportChanges(job);
    return { jobId, acknowledged: true, state: job.state, report };
  }

  async function reportChanges(job: Job, options?: DeliveryOptions) {
    const { jobId } = job;
    const transactionId = job.reload!.transactionId;
    const pending = unresolved(job);
    const applied = job.transaction!.proposalIds.map(pid => job.proposals.find(p => p.proposalId === pid)!.text);
    const result = await delivery(jobId, 'reportDelivery', messageId => host.notify(
      `本批记忆更新已提交且已收到你的重读回执。请向用户简洁汇报一次实际变化，不使用固定开头：${JSON.stringify(applied)}。${job.compaction!.status === 'skipped' ? '本轮选择了跳过压缩，不要声称发生压缩。' : job.compaction!.status === 'no_op' ? '本次压缩为无操作，不要声称发生压缩。' : ''}${pending ? '仍有提案保留待处理。' : ''}梦境仅作为梦中感受描述，勿当事实。`,
      { messageId, jobId, transactionId }), options);
    if (result.state === 'sent' && pending && eligibleProposals(job).length) submit({ jobId });
    return result;
  }

  async function status({ jobId }: { jobId?: string } = {}) {
    if (!jobId) return { jobs: (await store.listJobs()).filter(j => isDeepStrictEqual(j.scope, scope)).map(j => ({ jobId: j.jobId, state: j.state, applied: j.appliedProposalIds.length, proposals: j.proposals.length, error: j.error, recovery: j.recovery, deliveries: deliveries(j) })) };
    const job = await get(jobId);
    return { jobId, state: job.state, compactionMode: config.compactionMode, contextPressure: contextPressure(), compactionChoice: job.compactionChoice,
      compactionTransactionId: job.transaction?.transactionId, compaction: job.compaction, dreamPath: job.dreamPath, reviewPolicy: 'isolated-evidence-v1', proposals: job.proposals.map(p => ({ proposalId: p.proposalId, kind: p.kind, targetId: p.targetId, operation: p.operation, before: p.before, after: p.after, evidence: p.evidence, decision: latestReview(job, p.proposalId)?.decision ?? 'pending', reviewAuthority: latestReview(job, p.proposalId)?.authority, approvalCurrent: reviewMatches(job, latestReview(job, p.proposalId)), applied: job.appliedProposalIds.includes(p.proposalId) })), 
      sources: job.snapshot.sources.map(s => ({ sourceId: s.sourceId, path: sourcePath(config, s), role: s.role })),
      reload: job.reload && { transactionId: job.reload!.transactionId, status: job.reload.status, sources: job.reload.sources!?.map(s => ({ sourceId: s.sourceId, path: s.path })) }, error: job.error, recovery: job.recovery, deliveries: deliveries(job) };
  }

  async function reopenConflict(job: Job) {
    if (tasks.has(job.jobId)) throw new Error('Wait for the current submission to settle before resolving its conflict');
    if (job.transaction) {
      try { await store.cancelUnwritten(job.transaction.transactionId, { reason: job.error?.message ?? 'Reviewed inputs changed' }); }
      catch (error) {
        if (errorFields(error).code !== 'TRANSACTION_NOT_CANCELLABLE') throw error;
        await update(job.jobId, current => ({ ...current, recovery: { action: 'inspect_partial_transaction',
          transactionId: current.transaction!.transactionId,
          message: 'A target write may have started. Compare the transaction manifest, backups and current files; do not roll back user edits. Restore a verified recoverable state before retrying, or request an explicit reconciliation.' } }));
        throw error;
      }
    }
    // Persist cancellation before reopening. A crash between these writes is safe:
    // cancelUnwritten is idempotent, and old accepts remain historical, not authority.
    job = await update(job.jobId, current => {
      if (!['failed', 'cancelled'].includes(current.state) || !['prepared', 'applying'].includes(current.phase!)) {
        throw new Error('Conflict state changed while reopening');
      }
      const next: Job = { ...current, state: 'awaiting_review', updatedAt: time(), committingProposalIds: [],
        invalidatedReviewIds: [...new Set([...(current.invalidatedReviewIds ?? []),
          ...current.reviews.filter(r => r.decision === 'accept' && !current.appliedProposalIds.includes(r.proposalId)).map(r => r.reviewId)])],
        abandonedTransactions: [...(current.abandonedTransactions ?? []), ...(current.transaction ? [{
          transactionId: current.transaction!.transactionId, reason: current.error?.message, at: time(),
        }] : [])], recovery: { action: 'review_again', message: 'Unwritten transaction cancelled. Request a fresh isolated review, reject or defer.' } };
      for (const field of ['transaction', 'phase', 'checkpoint', 'error', 'reviewDelivery', 'attentionDelivery', 'reload', 'reloadDelivery', 'reportDelivery'] as const) delete next[field];
      return next;
    });
    // Keep the old snapshot for obsolete proposals that can still be rejected.
    // An explicit accept refreshes it and validates its current evidence.
    await requestReview(job);
    return { jobId: job.jobId, state: job.state, requiresReview: true };
  }

  async function retry({ jobId }: { jobId: string }, { signal: generationSignal }: { signal?: AbortSignal } = {}) {
    let job = await get(jobId);
    if (['queued', 'collecting'].includes(job.state) ||
      (['failed', 'cancelled'].includes(job.state) && ['queued', 'collecting'].includes(job.phase!))) {
      if (!inRestWindow(now(), config)) return { jobId, waiting: 'rest_window' };
      const activeSignal = signal && generationSignal ? AbortSignal.any([signal, generationSignal]) : generationSignal ?? signal;
      queue(jobId, () => generationLock(async () => continueEarly(await get(jobId), activeSignal)));
      return { jobId, queued: true };
    }
    if (['failed', 'cancelled'].includes(job.state) && ['prepared', 'applying'].includes(job.phase!) &&
      ['FILE_CONFLICT', 'FS_STALE_VERSION', 'TRANSACTION_CANCELLED', 'CLEAN_REVIEW_REQUIRED'].includes(job.error?.code!) &&
      job.recovery?.action !== 'inspect_partial_transaction') return reopenConflict(job);
    if (job.reload?.acknowledgedAt && ['awaiting_review', 'completed'].includes(job.state)) {
      const result = await reportChanges(job, { retry: true });
      return { jobId, delivery: result };
    }
    if (job.state === 'awaiting_review') {
      if (eligibleProposals(job).length || !unresolved(job)) return submit({ jobId });
      return { jobId, delivery: await requestReview(job, { retry: true }) };
    }
    if (job.state === 'awaiting_compaction') {
      if (config.compactionMode === 'agent' && !job.compactionChoice) return { jobId, delivery: await requestCompactionDecision(job, { retry: true }) };
      await update(jobId, current => ({ ...current, compactionAttempts: 0, attentionDelivery: undefined }));
      return submit({ jobId });
    }
    if (job.state === 'awaiting_reload') {
      return { jobId, delivery: await prepareReload(jobId, { retry: true }) };
    }
    if (!['failed', 'cancelled'].includes(job.state)) throw new Error('Job has no retryable failure');
    if (job.phase === 'compacting') throw new Error('Compaction outcome is uncertain; inspect Host evidence before retrying');
    if (job.phase === 'generating') {
      const result = await store.loadDreamResult(jobId);
      if (!result && !inRestWindow(now(), config)) throw new Error('Generation retry must wait for the rest window');
      const activeSignal = signal && generationSignal ? AbortSignal.any([signal, generationSignal]) : generationSignal ?? signal;
      queue(jobId, () => generationLock(async () => {
        activeSignal?.throwIfAborted();
        const snapshot = result ? job.snapshot : await refreshed(job.snapshot);
        job = await update(jobId, current => ({ ...transition(current, 'generating', { now: time() }), snapshot, inputFingerprint: inputFingerprint(snapshot), attentionDelivery: undefined }));
        return generateJob(job, activeSignal);
      }));
    } else {
      job = await move(jobId, job.phase!);
      if (job.state === 'awaiting_reload') {
        return { jobId, delivery: await prepareReload(jobId, { retry: true }) };
      }
      if (job.state === 'awaiting_review') {
        if (eligibleProposals(job).length || !unresolved(job)) return submit({ jobId });
        return { jobId, delivery: await requestReview(job, { retry: true }) };
      }
      submit({ jobId });
    }
    return { jobId, queued: true };
  }

  async function resume() {
    for (let job of (await store.listJobs()).filter(j => isDeepStrictEqual(j.scope, scope))) {
      if (deliveryFields.some(field => job[field]?.state === 'queued')) {
        job = await update(job.jobId, current => {
          for (const field of deliveryFields) {
            if (current[field]?.state === 'queued') current[field] = { ...current[field], state: 'uncertain',
              error: { code: 'DELIVERY_INTERRUPTED', message: 'Delivery outcome was not recorded; inspect before an explicit retry' } };
          }
          return current;
        });
      }
      if (job.reload?.acknowledgedAt && !job.reportDelivery) await reportChanges(job);
      if (['queued', 'collecting'].includes(job.state)) {
        if (inRestWindow(now(), config)) await retry({ jobId: job.jobId });
      }
      else if (['prepared', 'applying', 'applied', 'awaiting_compaction'].includes(job.state)) submit({ jobId: job.jobId });
      else if (job.state === 'compacting') await fail(job.jobId, new Error('Compaction outcome is uncertain after interruption'));
      else if (job.state === 'generating') {
        if (await store.loadDreamResult(job.jobId)) {
          const jobId = job.jobId;
          queue(jobId, () => generationLock(async () => generateJob(await get(jobId), signal)));
        } else await fail(job.jobId, new Error('Dream executor was interrupted; retry in the rest window'));
      } else if (job.state === 'awaiting_review') {
        if (eligibleProposals(job).length || !unresolved(job)) submit({ jobId: job.jobId });
        else if (!job.reviewDelivery) await requestReview(job);
      }
      else if (job.state === 'awaiting_reload' && !job.reloadDelivery) await prepareReload(job.jobId);
    }
  }

  return { dream, review, submit, decideCompaction, ackReload, status, retry, resume,
    async flush() { await generating?.catch(() => {}); await Promise.allSettled([...pendingReviews]); await Promise.all([...tasks.values()]); },
  };
}
