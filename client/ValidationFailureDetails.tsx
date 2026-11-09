import * as React from 'react';
import type { DreamSettingsStatus } from './api.js';
const labels = {
  zh: { title: '校验失败详情（私密调试）', privacy: '包含模型引用与原文片段；仅供排查，不是事实认证或写入许可。模型正文只保存在私密 attempt 文件，受归档上限约束；是否截断见文件元数据。', quote: '失败的引用', nearest: '同源最相近片段', similarity: '字符相似度', source: '源文件', location: '位置', episode: '事件', evidence: '引用', none: '没有可比较的同源片段', saved: '原始输出归档', failed: '归档失败', partial: '近似搜索或引用显示已截断；结果不是全源穷尽比较。', algorithm: '算法' },
  en: { title: 'Validation failure details (private debug)', privacy: 'Contains a model quote and source excerpt for debugging only, not factual or write authority. Model output is stored only in the private attempt file, within its archive budget; check its truncation metadata.', quote: 'Failed quote', nearest: 'Closest same-source excerpt', similarity: 'Character similarity', source: 'Source file', location: 'Location', episode: 'Episode', evidence: 'Evidence', none: 'No comparable same-source excerpt', saved: 'Raw output archive', failed: 'Archive failed', partial: 'Search or quote display was truncated; the comparison is not exhaustive over the full source.', algorithm: 'Algorithm' },
};
export function ValidationFailureDetails({ jobs, language }: { jobs: DreamSettingsStatus['jobs']; language: string }) {
  const records = jobs?.filter(job => job.error?.details).slice(-5).reverse();
  if (!records?.length) return null;
  const t = labels[language.startsWith('zh') ? 'zh' : 'en'];
  return <details data-generation-validation="private-content"><summary>{t.title}</summary>
    <p className="dream-settings-description">{t.privacy}</p>
    {records.map(job => {
      const details = job.error!.details!, issue = details.validationIssue;
      return <section key={job.jobId}>
        <p className="dream-settings-description dream-settings-mono">{job.jobId} · {details.attemptId}</p>
        <p className="dream-settings-description">{details.archiveState === 'saved' ? t.saved : t.failed}: <code>{details.attemptPath ?? details.archiveErrorCode}</code></p>
        {issue ? <>
          <p className="dream-settings-description">{t.episode} {issue.episodeIndex + 1} ({issue.episodeId}) · {t.evidence} {issue.evidenceIndex + 1}</p>
          <p className="dream-settings-description">{t.source}: <code>{issue.sourcePath ?? issue.sourceId}</code></p>
          <p className="dream-settings-label">{t.quote}</p><pre className="dream-settings-validation-text">{issue.quote}</pre>
          <p className="dream-settings-label">{t.nearest}</p>{issue.nearest ? <>
            <pre className="dream-settings-validation-text">{issue.nearest.text}</pre>
            <p className="dream-settings-description">{t.similarity}: {(issue.nearest.similarity * 100).toFixed(2)}% · {t.location}: {issue.nearest.lineStart}–{issue.nearest.lineEnd}</p>
          </> : <p className="dream-settings-description">{t.none}</p>}
          <p className="dream-settings-description">{t.algorithm}: <code>{issue.algorithm}</code></p>
          {(issue.quoteTruncated || issue.search.truncated) && <p className="dream-settings-description">{t.partial}</p>}
        </> : <pre className="dream-settings-validation-text">{job.error!.message}</pre>}
      </section>;
    })}
  </details>;
}
