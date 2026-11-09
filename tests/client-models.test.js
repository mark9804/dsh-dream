import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import ts from 'typescript';
import { draftOf, modelChoiceError, modelFields, numericFields, serializeDraft } from '../client/draft.ts';
import { en, zh } from '../client/locale.ts';

// In-memory synthetic component evaluation only: no bundle publication, server,
// profile, model invocation, real session or memory fixtures.
const require = createRequire(import.meta.url);
const React = require('react'), { renderToStaticMarkup } = require('react-dom/server');
const output = await build({ entryPoints: ['client/ModelsSection.tsx'], bundle: true, write: false, platform: 'node', format: 'cjs', jsx: 'automatic', external: ['react', 'react/jsx-runtime'] });
const module = { exports: {} };
new Function('require', 'module', 'exports', output.outputFiles[0].text)(require, module, module.exports);
const { ModelChoiceCard, ModelsSection, createModelCatalogLoader } = module.exports;
const t = key => en[key];
const id = key => `synthetic-${key}`;
const catalog = {
  groups: [
    { id: 'one', name: 'Provider one', models: [
      { id: 'reasoner', name: 'Reasoner', reasoning: { efforts: [{ id: 'careful-42', name: 'Careful', description: 'Actual adapter capability' }, { id: 'default', name: 'Literal default ID' }], defaultEffort: 'careful-42' } },
      { id: 'plain', name: 'Plain model' },
    ] },
    { id: 'two', name: 'Provider two', models: [{ id: 'other', name: 'Other model', reasoning: { efforts: [{ id: 'thoughtful', name: 'Thoughtful' }] } }] },
  ], failures: [], current: { provider: 'one', model: 'reasoner', reasoningEffort: 'careful-42' },
};
function fixture(changes = {}) {
  return { ...Object.fromEntries(Object.entries(numericFields).map(([field, rule]) => [field, rule.min])),
    sessionId: 'synthetic-session', memoryRoot: '/synthetic/memory', stateRoot: '/synthetic/state', start: '05:00', end: '07:00', timeZone: 'local',
    compactionMode: 'auto', singleRun: false, dreamMode: 'separate', sourceSessionIds: [], originalSources: [], dreamContextRefs: [], timeoutMs: 900000, dreamTimeoutMs: 180000, ...changes };
}
function elements(tree) {
  const result = [];
  function visit(node) {
    if (!React.isValidElement(node)) return;
    result.push(node); React.Children.forEach(node.props.children, visit);
  }
  visit(tree); return result;
}
const named = (tree, name) => elements(tree).filter(element => element.type?.name === name);
function card(value, extra = {}) {
  const changes = [];
  const props = { field: 'memoryModel', value, catalog, disabled: false, id, onChange: (field, selection) => changes.push({ field, selection }), t, ...extra };
  return { tree: ModelChoiceCard(props), props, changes };
}
function select(tree, suffix) { return named(tree, 'SearchSelect').find(element => element.props.id.endsWith(suffix)); }
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }

test('model choice shapes are optional, independent and preserve unlisted but valid saved IDs', () => {
  assert.deepEqual(modelFields, ['memoryModel', 'dreamModel', 'reviewModel']);
  const saved = fixture({ memoryModel: { provider: 'old-provider', model: 'old-model' }, dreamModel: { reasoningEffort: 'adapter-effort' }, reviewModel: {} });
  const before = structuredClone(saved), draft = draftOf(saved), result = serializeDraft(draft);
  assert.deepEqual(result.errors, {}); assert.deepEqual(result.config, saved); assert.deepEqual(saved, before);
  draft.memoryModel.provider = 'new-provider'; assert.equal(saved.memoryModel.provider, 'old-provider');
  const unset = serializeDraft(draftOf(fixture()));
  for (const field of modelFields) assert.equal(Object.hasOwn(unset.config, field), false, 'No defaults silently added');
  const incomplete = draftOf(fixture({ memoryModel: { reasoningEffort: 'careful-42' } }));
  delete incomplete.sessionId; delete incomplete.memoryRoot; delete incomplete.stateRoot;
  assert.deepEqual(serializeDraft(incomplete, { enabled: false }).errors, {});
});

test('model choice validation rejects malformed route pairs and unsafe IDs without mutating the draft', () => {
  const invalid = [null, [], 'one/reasoner', 1, true, new Date(0), { provider: 'one' }, { model: 'reasoner' },
    { provider: '', model: '' }, { provider: ' one', model: 'reasoner' }, { provider: 'one', model: 'with space' },
    { reasoningEffort: '' }, { reasoningEffort: 'a\nb' }, { reasoningEffort: 'a\u0000b' }, { reasoningEffort: 7 },
    { provider: 'x'.repeat(513), model: 'reasoner' }, { provider: 'one', model: 'x'.repeat(513) }, { reasoningEffort: 'x'.repeat(129) },
    { provider: 'one', model: 'reasoner', temperature: 1 }, { reasoningEffort: 'careful-42', approved: true }];
  for (const field of modelFields) for (const value of invalid) {
    const draft = draftOf(fixture()); draft[field] = value;
    assert.equal(modelChoiceError(value), 'fieldModelChoice');
    const result = serializeDraft(draft); assert.equal(result.errors[field], 'fieldModelChoice');
    assert.equal(draft[field], value);
  }
  for (const value of [undefined, {}, { reasoningEffort: 'x'.repeat(128) }, { provider: 'x'.repeat(512), model: 'y'.repeat(512) }]) assert.equal(modelChoiceError(value), undefined);
  let getters = 0;
  const accessor = Object.defineProperty({}, 'provider', { enumerable: true, get() { getters++; return 'one'; } });
  const symbol = { [Symbol('authority')]: true };
  for (const value of [accessor, symbol]) {
    const draft = draftOf(fixture()); draft.reviewModel = value;
    assert.equal(serializeDraft(draft).errors.reviewModel, 'fieldModelChoice');
  }
  assert.equal(getters, 0);
});

test('follow mode exposes only actual current-model efforts and never writes on render', () => {
  const f = card(undefined);
  assert.equal(f.changes.length, 0);
  assert.equal(named(f.tree, 'ChoiceCards')[0].props.value, 'follow');
  assert.equal(select(f.tree, '-provider'), undefined);
  const effort = select(f.tree, '-effort');
  assert.equal(effort.props.value, 'default');
  assert.deepEqual(effort.props.options.map(item => item.value), ['default', 'effort:careful-42', 'effort:default']);
  assert.equal(effort.props.options[0].label, en.modelEffortFollow);
  assert.match(effort.props.options[1].label, /Careful.*careful-42/);
  assert.equal(effort.props.options[1].description, 'Actual adapter capability');
  effort.props.onChange('effort:careful-42');
  assert.deepEqual(f.changes, [{ field: 'memoryModel', selection: { reasoningEffort: 'careful-42' } }]);
  const overridden = card({ reasoningEffort: 'careful-42' });
  select(overridden.tree, '-effort').props.onChange('default');
  assert.deepEqual(overridden.changes, [{ field: 'memoryModel', selection: undefined }]);
});

test('route switches require explicit selection and clear only this branch reasoning override', () => {
  const follow = card({ reasoningEffort: 'careful-42' });
  named(follow.tree, 'ChoiceCards')[0].props.onChange('custom');
  assert.deepEqual(follow.changes, [{ field: 'memoryModel', selection: { provider: '', model: '' } }]);
  const saved = { provider: 'one', model: 'reasoner', reasoningEffort: 'careful-42' };
  const f = card(saved, { field: 'dreamModel' });
  select(f.tree, '-provider').props.onChange('two');
  select(f.tree, '-model').props.onChange('plain');
  named(f.tree, 'ChoiceCards')[0].props.onChange('follow');
  assert.deepEqual(f.changes, [
    { field: 'dreamModel', selection: { provider: 'two', model: '' } },
    { field: 'dreamModel', selection: { provider: 'one', model: 'plain' } },
    { field: 'dreamModel', selection: undefined },
  ]);
  assert.deepEqual(saved, { provider: 'one', model: 'reasoner', reasoningEffort: 'careful-42' });
  const custom = card({ provider: 'one', model: 'reasoner' });
  const effort = select(custom.tree, '-effort');
  assert.equal(effort.props.options[0].label, en.modelEffortDefault);
  effort.props.onChange('default'); assert.deepEqual(custom.changes, [], 'Adapter default is not turned into an explicit effort');
  effort.props.onChange('effort:default');
  assert.deepEqual(custom.changes, [{ field: 'memoryModel', selection: { provider: 'one', model: 'reasoner', reasoningEffort: 'default' } }], 'An actual effort ID named default is not the UI default');
});

test('catalog changes preserve unavailable provider, model and effort choices with correction controls', () => {
  const saved = { provider: 'gone', model: 'old-model', reasoningEffort: 'old-effort' };
  const f = card(saved);
  assert.equal(select(f.tree, '-provider').props.value, 'gone');
  assert.ok(select(f.tree, '-provider').props.options.some(item => item.value === 'gone' && item.description === en.modelSavedUnavailable));
  assert.ok(select(f.tree, '-model').props.options.some(item => item.value === 'old-model'));
  assert.ok(select(f.tree, '-effort').props.options.some(item => item.value === 'effort:old-effort'));
  assert.equal(f.changes.length, 0);
  const html = renderToStaticMarkup(React.createElement(ModelChoiceCard, f.props));
  assert.ok(html.includes(en.modelSelectionUnavailable)); assert.ok(html.includes(en.modelReset));
  const reset = named(f.tree, 'Button').find(element => element.props.children === en.modelReset); reset.props.onClick();
  assert.deepEqual(f.changes, [{ field: 'memoryModel', selection: undefined }]);
  const staleCurrent = card(undefined, { catalog: { ...catalog, current: { ...catalog.current, reasoningEffort: 'retired-effort' } } });
  const currentHtml = renderToStaticMarkup(React.createElement(ModelChoiceCard, staleCurrent.props));
  assert.ok(currentHtml.includes(en.modelSelectionUnavailable), 'Unavailable inherited effort is visible too'); assert.deepEqual(staleCurrent.changes, []);
});

test('plain models offer no invented effort and missing metadata still permits clearing a saved override', () => {
  const plain = card({ provider: 'one', model: 'plain' });
  assert.equal(select(plain.tree, '-effort').props.disabled, true);
  assert.deepEqual(select(plain.tree, '-effort').props.options.map(item => item.value), ['default']);
  const missing = card({ provider: 'one', model: 'plain', reasoningEffort: 'retired-effort' });
  assert.equal(select(missing.tree, '-effort').props.disabled, false);
  select(missing.tree, '-effort').props.onChange('default');
  assert.deepEqual(missing.changes, [{ field: 'memoryModel', selection: { provider: 'one', model: 'plain' } }]);
});

test('disabled cards disable every control and synthetic callbacks cannot change a draft', () => {
  const f = card({ provider: 'one', model: 'reasoner', reasoningEffort: 'careful-42' }, { disabled: true, error: 'fieldModelChoice' });
  for (const element of [...named(f.tree, 'SearchSelect'), ...named(f.tree, 'ChoiceCards'), ...named(f.tree, 'Button')]) assert.equal(element.props.disabled, true);
  named(f.tree, 'ChoiceCards')[0].props.onChange('follow');
  select(f.tree, '-provider').props.onChange('two'); select(f.tree, '-model').props.onChange('plain'); select(f.tree, '-effort').props.onChange('default');
  named(f.tree, 'Button')[0].props.onClick(); assert.deepEqual(f.changes, []);
  const html = renderToStaticMarkup(React.createElement(ModelChoiceCard, f.props));
  assert.match(html, /data-model-branch="memoryModel"/); assert.match(html, /aria-invalid="true"/);
  assert.match(html, /synthetic-memoryModel-route-error/); assert.match(html, /synthetic-memoryModel-provider-label/); assert.match(html, /synthetic-memoryModel-effort-label/);
});

test('catalog loader isolates late results by session and aborts replaced or disposed requests', async () => {
  const calls = [], states = [];
  const loader = createModelCatalogLoader((input, signal) => { const result = deferred(); calls.push({ input, signal, ...result }); return result.promise; }, state => states.push(state));
  assert.deepEqual(calls, []);
  const first = loader.load('first'); const second = loader.load('second');
  assert.equal(calls[0].signal.aborted, true); assert.deepEqual(calls[1].input, { sessionId: 'second' });
  assert.deepEqual(states.at(-1), { sessionId: 'second', phase: 'loading' });
  calls[1].resolve(catalog); await second;
  calls[0].resolve({ groups: [], failures: [] }); await first;
  assert.equal(states.at(-1).sessionId, 'second'); assert.equal(states.at(-1).catalog, catalog);
  const third = loader.load(); assert.equal(calls[1].signal.aborted, true); assert.deepEqual(calls[2].input, {});
  const before = states.length; loader.dispose(); assert.equal(calls[2].signal.aborted, true);
  calls[2].reject(new Error('late cancellation')); await third; await loader.load('ignored');
  assert.equal(states.length, before); assert.equal(calls.length, 3);
});

test('catalog loader reports errors and unavailable API without inventing an empty success', async () => {
  const states = []; let attempts = 0;
  const loader = createModelCatalogLoader(async () => { if (!attempts++) throw new Error('Synthetic provider error'); return { ...catalog, failures: [{ id: 'failed', name: 'Failed provider', message: 'Synthetic metadata failure' }] }; }, state => states.push(state));
  await loader.load('one'); assert.equal(states.at(-1).phase, 'error'); assert.equal(states.at(-1).message, 'Synthetic provider error');
  await loader.load('one'); assert.equal(states.at(-1).phase, 'success'); assert.equal(states.at(-1).catalog.failures.length, 1); loader.dispose();
  const unavailable = createModelCatalogLoader(undefined, state => states.push(state)); await unavailable.load('legacy');
  assert.deepEqual(states.at(-1), { sessionId: 'legacy', phase: 'unavailable' }); unavailable.dispose();
});

test('the full section renders three named branches and safe fallback for older API fixtures without I/O', () => {
  const changes = [];
  const html = renderToStaticMarkup(React.createElement(ModelsSection, { api: {}, sessionId: 'synthetic-session', draft: { memoryModel: { provider: 'gone', model: 'old' } }, errors: {}, disabled: false, id, onChange: (...args) => changes.push(args), t: key => zh[key] }));
  assert.equal((html.match(/data-model-branch=/g) ?? []).length, 3);
  for (const field of modelFields) assert.ok(html.includes(`data-model-branch="${field}"`));
  for (const text of ['模型与推理', '记忆整理', '独立梦境', '独立审核', zh.modelCatalogUnavailable, zh.modelReset]) assert.ok(html.includes(text), text);
  assert.match(html, /aria-labelledby="synthetic-models-heading"/); assert.match(html, /aria-busy="false"/);
  assert.deepEqual(changes, []); assert.doesNotMatch(html, /<form|<script/);
});

test('models section is a basic sibling immediately after daily, before setup and advanced, using the shared explicit save', async () => {
  const page = await readFile(new URL('../client/SettingsPage.tsx', import.meta.url), 'utf8');
  const ast = ts.createSourceFile('SettingsPage.tsx', page, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found = [];
  function visit(node) { found.push(node); ts.forEachChild(node, visit); } visit(ast);
  const group = name => found.find(node => ts.isJsxElement(node) && node.openingElement.attributes.properties.some(attribute => ts.isJsxAttribute(attribute) && attribute.name.getText(ast) === 'data-settings-group' && attribute.initializer?.text === name));
  const modelNode = found.find(node => ts.isJsxSelfClosingElement(node) && node.tagName.getText(ast) === 'ModelsSection');
  assert.ok(modelNode); assert.ok(group('daily').end < modelNode.pos && modelNode.end < group('setup').pos);
  assert.ok(group('basic').pos < modelNode.pos && modelNode.end < group('basic').end && modelNode.end < group('advanced').pos);
  assert.match(modelNode.getText(ast), /draft=\{draft\}.*errors=\{errors\}.*onChange=\{update\}/);
  const source = await readFile(new URL('../client/ModelsSection.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /api\.(?:save|preflight|read|status)\(|fetch\(|localStorage|setInterval|prepareCall|\.stream\(/);
  assert.match(source, /state\.sessionId === sessionId/); assert.match(source, /current === epoch/);
  const css = await readFile(new URL('../client/styles.css', import.meta.url), 'utf8');
  assert.match(css, /\.dream-settings-model-card/); assert.match(css, /\.dream-settings-model-card \.dream-settings-choice-group \{ grid-template-columns: 1fr/);
});
