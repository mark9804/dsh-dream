// Build a content-first dossier from one completed synthetic trial, never rewrite model output.
import assert from 'node:assert/strict';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { join, resolve, relative } from 'node:path';
const repo = resolve(import.meta.dirname, '..'), root = resolve(process.argv[2] ?? '');
assert.ok(root.startsWith(join(repo, 'tests/.tmp/memory-v2-live-')));
const json = async p => JSON.parse(await readFile(join(root, p), 'utf8'));
const final = await json('final-job.json'), result = await json('generated-result.json'), baseline = await json('baseline.json'), after = await json('final-memory.json');
const task = await json(`state/dream-tasks/${final.jobId}.json`), mid = await json('memory-finished-while-dream-held.json'), input = await json('dream-input.json'), meta = await json('provenance.json');
const link = (label, path) => `[${label}](<${relative(join(repo, 'docs'), join(root, path))}>)`;
const fence = (text, language = 'text') => ['```' + language, text, '```', ''];
const out = ['# 分段记忆与独立梦境：本轮完整内容', '',
  '本页不是只报“测试通过”：完整展示输入、事件分层、提案、独立审核、最终文件、梦与梦后感受。所有人物、对话与记忆均为合成，不是用户真实经历。未润色或重抽生成内容。', '',
  '## 范围与方法', '',
  '真实Host的fs/llm/sessionQuery；预编user+assistant历史放入独立合成session。程序请求review，但决策来自真实独立模型；idle/maintenance/通知是受控测试driver，不声称本轮验证了生产主会话调度。梦writer人为等待，记忆流程完成再放行，以证明独立性。', '',
  ...(meta.organizerReplayPath ? ['本轮为保留层级提示修订的定向试验：ORGANIZE重放前一轮已保存的真实模型原始输出（不是本轮新调用）；DEEP、各项独立审核和梦均为本轮真实模型调用。没有重放接受决定。', ''] : []),
  link('完整试验声明', 'provenance.json') + ' · ' + link('核验结果', 'verification.json'), '',
  '## 初始文件全文', ''];
for (const [p, text] of Object.entries(baseline)) out.push('### ' + p, '', ...fence(text, 'markdown'));
const source = await json('source-events.json');
out.push('## 合成对话原文', '', '以下assistant历史是预编夹具，不是本轮真实生成；其内容只用于梦境上下文，不是新事实证据。', '');
for (const event of source.events) {
  if (!['user/message', 'assistant/message'].includes(event.type)) continue;
  const message = event.type === 'user/message' ? event.data : event.data.message;
  out.push(`**${message.role} · seq ${event.seq}**`, '', ...fence(message.content.filter(b => b.type === 'text').map(b => b.text).join('\n')));
}
out.push('## ORGANIZE：事件与重要性原文', '', '分类、status与保留位置是模型判断；引用核对不等于语义必真，coverage不保证全事件覆盖。', '', ...fence(JSON.stringify(result.digest, null, 2), 'json'));
out.push('## DEEP：全部候选与独立审核', '');
for (const p of final.proposals) {
  const reviews = final.reviews.filter(r => r.proposalId === p.proposalId);
  out.push('### ' + p.proposalId, '', ...fence(JSON.stringify(p, null, 2), 'json'));
  for (const r of reviews) out.push('**审核 ' + r.decision + '**', '', r.reason, '', ...fence(JSON.stringify(r.authority, null, 2), 'json'));
  out.push('实际提交：' + (final.appliedProposalIds.includes(p.proposalId) ? '是' : p.operation === 'retain' && reviews.at(-1)?.decision === 'accept' ? '只保留审核记录，未写正文' : '否') + '。', '');
}
out.push('## 记忆结束时，梦仍未生成', '', ...fence(JSON.stringify({ at: mid.at, memoryState: mid.job.state, applied: mid.job.appliedProposalIds, narrative: mid.status.narrative }, null, 2), 'json'),
  '本轮跳过压缩；重读由driver通过受控fs实际读取并回执，不改主会话。', '',
  '## 梦境实际输入', '', ...fence(JSON.stringify(input, null, 2), 'json'),
  '## 自由创作实际提示全文', '', ...fence(await readFile(join(root, 'dream-prompt.txt'), 'utf8')),
  '## 梦境完整原文', '', '> 以下为梦，不是事实证据。', '', task.output.dream, '',
  '## 梦后感受原文', '', task.output.afterFeeling || '（模型返回空字符串）', '',
  '该感受未写入长期记忆、人格或现有心情插件，也未注入主会话。', '',
  '## 最终文件全文', '');
for (const [p, text] of Object.entries(after)) out.push('### ' + p, '', ...fence(text, 'markdown'));
out.push('## 原始请求与原始输出', '');
for (const n of (await readdir(join(root, 'audit'))).filter(n => n.endsWith('.json'))) {
  const a = await json('audit/' + n);
  out.push('- ' + a.phase + ' · ' + link(a.id, 'audit/' + n) + ' · ' + link('未加工输出', 'raw/' + a.id + '.txt'));
}
out.push('', '## 解释边界', '',
  '这是一次合成试验，不代表长期效果或“模仿人脑”成立。实际保留/纠正由原文支持和独立审核决定；低优先级号码原文保留，不承诺自动归档。梦是表现层，不把虚构内容用作真实关系、事实或人格。', '',
  '[实现与测试报告](<memory-stages-2026-11-04.md>)');
const target = join(repo, process.argv[3] ?? 'docs/memory-stages-content-2026-11-04.md');
assert.ok(target.startsWith(join(repo, 'docs/')));
await writeFile(target, out.join('\n') + '\n', { flag: 'wx' });
console.log(JSON.stringify({ target, episodes: result.digest.episodes.length, proposals: final.proposals.length, dreamCharacters: task.output.dream.length, sourceId: meta.sourceId }, null, 2));
