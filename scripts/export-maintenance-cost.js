import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve, relative } from 'node:path';
const root = resolve(process.argv[2] ?? ''), repo = resolve(import.meta.dirname, '..');
assert.ok(root.includes('/tests/.tmp/continuity-host-'));
const json = async p => JSON.parse(await readFile(join(root, p), 'utf8')), cost = await json('maintenance-cost-verification-with-retries.json'), fixture = await json('fixture-gold.json');
const f = (v, lang = 'json') => ['```' + lang, typeof v === 'string' ? v : JSON.stringify(v, null, 2), '```', ''];
const link = (label, p) => `[${label}](<${relative(join(repo, 'docs'), join(root, p))}>)`;
const lines = ['# 调用成本与过程通知：同素材实机完整实录', '', '所有人物/经历均为合成虚构；三晚是固定时钟，模型与临时AgentLoop/文件写入/独立审核/实际重读真实执行。本轮不重跑12个自主问答，比较只计维护请求；新model输出与旧输出有差异，不是同一回答的强制回放。', '', link('完整指标与公开文字', 'maintenance-cost-verification-with-retries.json') + ' · ' + link('机械proof核验', 'verification.json') + ' · ' + link('剔除reasoning的完整原生事件', 'owner-events-final.json'), '', '## 前后指标', '', ...f(cost.comparison), '### 本轮全部工具', '', ...f(cost.after.toolCounts), '### 各晚全部提案与审核', ''];
for (const night of fixture.nights) {
  const job = await json('final/' + night.id + '.json');
  lines.push('## ' + night.id, '', '本晚新增原话：', '', ...f(night.messages.join('\n\n'), 'text'));
  for (const p of job.proposals) lines.push('### ' + p.proposalId, '', ...f(p), '独立审核完整理由和authority：', '', ...f(job.reviews.filter(r => r.proposalId === p.proposalId).map(r => ({ reviewId: r.reviewId, decision: r.decision, reason: r.reason, authority: r.authority, reviewedAt: r.reviewedAt }))), '实际写入：' + job.appliedProposalIds.includes(p.proposalId), '');
  lines.push('### 实际批次、重读及同素材复用', '', ...f({ state: job.state, transactionHistory: job.transactionHistory, repeat: await json('repeat/' + night.id + '.json') }), '### 本晚最终长期记忆', '', ...f(await readFile(join(root, 'memory-' + night.id + '.md'), 'utf8'), 'markdown'));
}
lines.push('## 本轮全部公开文字（不剔除多余确认）', '', ...f(cost.after.publicMessages), '## 原基线全部公开文字', '', ...f(cost.before.publicMessages), '## 完整读→下一请求ACK凭据', '', ...f(cost.after.reloadProofs), '[实现、边缘修复与限制](<maintenance-cost-2026-11-05.md>)', '');
const target = join(repo, process.argv[3] ?? 'docs/maintenance-cost-content-2026-11-05.md');
await writeFile(target, lines.join('\n') + '\n', { flag: 'wx' }); console.log(JSON.stringify({ target, nights: fixture.nights.length, publicMessages: cost.after.publicMessageCount }));
