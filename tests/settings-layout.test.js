import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
const source = await readFile(new URL('../client/SettingsPage.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('SettingsPage.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function descendants(node, predicate) {
  const found = [];
  function visit(child) { if (predicate(child)) found.push(child); ts.forEachChild(child, visit); }
  visit(node); return found;
}
function group(name) {
  const nodes = descendants(ast, node => ts.isJsxElement(node) && node.openingElement.attributes.properties.some(attribute => ts.isJsxAttribute(attribute) && attribute.name.getText(ast) === 'data-settings-group' && attribute.initializer?.text === name));
  assert.equal(nodes.length, 1, `One semantic ${name} group`); return nodes[0];
}
const inside = (parent, child) => child.pos >= parent.pos && child.end <= parent.end;
const text = node => node.getText(ast);
const pathCalls = node => descendants(node, item => ts.isCallExpression(item) && text(item.expression) === 'pathField').map(item => item.arguments[0]?.text);

test('basic settings contain daily and setup siblings before advanced settings', () => {
  const basic = group('basic'), daily = group('daily'), setup = group('setup'), advanced = group('advanced');
  assert.ok(inside(basic, daily)); assert.ok(inside(basic, setup)); assert.ok(!inside(daily, setup));
  assert.ok(daily.end < setup.pos && basic.end < advanced.pos);
  for (const section of [basic, daily, setup]) assert.match(text(section.openingElement), /aria-labelledby=/);
  assert.equal(descendants(ast, node => ts.isJsxOpeningElement(node) && text(node.tagName) === 'form').length, 1, 'One shared explicit-save form');
});
test('daily group owns runtime enablement, time window, dream switch and compression choice only', () => {
  const daily = text(group('daily'));
  for (const field of ['enabled', 'dreamMode', 'compactionMode', 'timeZone']) assert.ok(daily.includes(`id('${field}')`), field);
  assert.match(daily, /\['start', 'end'\]/);
  assert.deepEqual(pathCalls(group('daily')), []);
  assert.doesNotMatch(daily, /singleRun|recallHistoryDays|sourceSessionIds/);
});
test('all three path pickers and target session are visible together outside the advanced collapse', () => {
  const setup = group('setup'), advanced = group('advanced');
  assert.deepEqual(pathCalls(setup), ['memoryRoot', 'stateRoot', 'personaPath']);
  assert.deepEqual(pathCalls(advanced), []);
  assert.match(text(setup), /id\('sessionId'\)/);
  for (const field of ['memoryRoot', 'stateRoot', 'personaPath']) assert.equal(pathCalls(ast).filter(value => value === field).length, 1, `No duplicate editor for ${field}`);
  assert.doesNotMatch(text(setup), /<Advanced|<ShadcnCollapsible/);
});
test('advanced retains historical recall, budgets, timeouts, source permissions and development controls', () => {
  const advanced = text(group('advanced'));
  for (const name of ['recallHistoryDays', 'maxRecallFiles', 'maxRecallBytes', 'reinforcementBoost', 'dreamTimeoutMs', 'maxDreamContextBytes', 'singleRun', 'sourceSessionIds', 'originalSources', 'dreamContextRefs']) assert.ok(advanced.includes(name), name);
  assert.match(advanced, /budgetFields\.map\(numeric\)/);
  assert.match(advanced, /<Advanced title=\{t\('advanced'\)\}/);
  assert.doesNotMatch(advanced, /defaultOpen=|open=\{true\}/);
});
test('layout reorganization keeps explicit save, scope confirmations and existing Base UI controls', async () => {
  assert.match(source, /onSubmit=\{event => \{ event\.preventDefault\(\); void requestSave\(\); \}\}/);
  assert.match(source, /confirmScope: true/); assert.match(source, /confirmEnable: true/);
  const ui = await readFile(new URL('../client/ui.tsx', import.meta.url), 'utf8');
  assert.match(ui, /<ShadcnCollapsible/); assert.match(ui, /<ShadcnSwitch/);
  assert.doesNotMatch(source, /localStorage|sessionStorage|configEditor|writeFile/);
});
