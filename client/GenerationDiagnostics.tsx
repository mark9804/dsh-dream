import * as React from 'react';
import type { GenerationDiagnostics as Diagnostic, GenerationStage } from '../src/domain/generation-diagnostics.js';
import type { DreamSettingsStatus } from './api.js';
const labels = {
  zh: { title: '生成阶段诊断', noData: '旧版本任务没有阶段记录，无法事后还原。', stage: '阶段', elapsed: '已耗时', budget: '总预算', settled: '执行器已退出', draining: '正在取消并等待调用退出', first: '首 token', output: '输出', reasoning: '推理', usage: '服务端用量', privacy: '仅记录阶段、时间和计数，不记录素材、生成正文或思维链；进度不代表提案已通过审核。', preparing: '准备请求', streaming: '等待／接收响应', completed: '完成', failed: '失败', cancelled: '已取消', timed_out: '超时', running: '运行中', starting: '启动', organize: '事件索引', deep: '整理提案', validation: '结果校验', legacy: '旧版生成' },
  en: { title: 'Generation diagnostics', noData: 'This older job has no stage trace; it cannot be reconstructed retrospectively.', stage: 'Stage', elapsed: 'Elapsed', budget: 'Total budget', settled: 'Executor settled', draining: 'Cancelling; waiting for the call to settle', first: 'First token', output: 'Output', reasoning: 'Reasoning', usage: 'Provider usage', privacy: 'Stages, times and counters only—no source text, generated text or chain of thought. Progress does not confer review approval.', preparing: 'Preparing', streaming: 'Waiting / receiving', completed: 'Completed', failed: 'Failed', cancelled: 'Cancelled', timed_out: 'Timed out', running: 'Running', starting: 'Starting', organize: 'Event index', deep: 'Consolidation', validation: 'Validation', legacy: 'Legacy generation' },
};
const duration = (milliseconds: number) => `${(milliseconds / 60000).toLocaleString(undefined, { maximumFractionDigits: 2 })} min`;
export function GenerationDiagnostics({ jobs, language }: { jobs: DreamSettingsStatus['jobs']; language: string }) {
  if (!jobs?.length) return null;
  const t = labels[language.startsWith('zh') ? 'zh' : 'en'];
  const stage = (value: GenerationStage) => t[value];
  function details(d: Diagnostic) {
    return <>
      <p className="dream-settings-description">{t.stage}: {stage(d.stage)} · {t[d.state]} · {t.elapsed}: {duration(d.elapsedMs)} / {t.budget}: {duration(d.timeoutMs)}</p>
      <ol>{d.calls.map(call => <li key={call.sequence}>
        <p className="dream-settings-description">{call.sequence}. {stage(call.stage)} · {t[call.state]} · {duration(call.elapsedMs)}{call.provider ? ` · ${call.provider} / ${call.model}` : ''}</p>
        <p className="dream-settings-description">{t.first}: {call.firstTokenAt ? duration(Math.max(0, Date.parse(call.firstTokenAt) - Date.parse(call.startedAt))) : '—'} · {t.output}: {call.outputBytes} B · {t.reasoning}: {call.reasoningBytes} B</p>
        {call.callId && <p className="dream-settings-description dream-settings-mono">{call.callId}</p>}
        {call.usage && <p className="dream-settings-description">{t.usage}: {JSON.stringify(call.usage)}</p>}
        {call.failureCode && <p className="dream-settings-description dream-settings-mono">{call.failureCode}</p>}
      </li>)}</ol>
      <p className="dream-settings-description">{d.settledAt ? t.settled : d.finishedAt ? t.draining : ''}</p>
    </>;
  }
  return <details data-generation-diagnostics="content-free"><summary>{t.title}</summary>
    <p className="dream-settings-description">{t.privacy}</p>
    {jobs.slice(-5).reverse().map(job => <section key={job.jobId}>
      <p className="dream-settings-description dream-settings-mono">{job.jobId} · {job.state}</p>
      {job.generationDiagnostics ? details(job.generationDiagnostics) : <p className="dream-settings-description">{t.noData}</p>}
    </section>)}
  </details>;
}
