import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
const require = createRequire(import.meta.url), React = require('react'), { renderToStaticMarkup } = require('react-dom/server');
const built = await build({ entryPoints: ['client/DurationInput.tsx'], bundle: true, write: false, platform: 'node', format: 'cjs', jsx: 'automatic', external: ['react', 'react/jsx-runtime'] });
const module = { exports: {} }; new Function('require', 'module', 'exports', built.outputFiles[0].text)(require, module, module.exports);
const { DurationInput } = module.exports;
const props = { id: 'synthetic-timeout', value: { minutes: '15', seconds: '0' }, onChange() {}, minutesLabel: '分钟', secondsLabel: '秒', describedBy: 'synthetic-description' };
test('duration InputGroup renders two named inputs and inline units with zero seconds by default', () => {
  const html = renderToStaticMarkup(React.createElement(DurationInput, props));
  assert.match(html, /role="group"/); assert.match(html, /data-slot="dream-settings-input-group"/);
  const inputs = html.match(/<input\b[^>]+>/g); assert.equal(inputs.length, 2);
  assert.match(inputs[0], /id="synthetic-timeout"/); assert.match(inputs[0], /inputMode="numeric"/); assert.match(inputs[0], /step="1"/); assert.match(inputs[0], /value="15"/);
  assert.match(inputs[1], /id="synthetic-timeout-seconds"/); assert.match(inputs[1], /value="0"/); assert.match(inputs[1], /placeholder="0"/); assert.match(inputs[1], /max="59\.999"/);
  for (const input of inputs) { assert.match(input, /aria-labelledby="synthetic-timeout-label synthetic-timeout-(minutes|seconds)-unit"/); assert.match(input, /aria-describedby="synthetic-description"/); }
  assert.ok(html.indexOf('value="15"') < html.indexOf('分钟') && html.indexOf('分钟') < html.indexOf('value="0"') && html.indexOf('value="0"') < html.indexOf('秒'));
});
test('editing either side preserves the other part and does not submit or normalize the group', () => {
  const changes = [], tree = DurationInput({ ...props, onChange: value => changes.push(value) });
  const children = React.Children.toArray(tree.props.children); assert.equal(children.length, 4);
  children[0].props.onChange({ target: { value: '2' } }); children[2].props.onChange({ target: { value: '30' } }); children[2].props.onChange({ target: { value: '' } });
  assert.deepEqual(changes, [{ minutes: '2', seconds: '0' }, { minutes: '15', seconds: '30' }, { minutes: '15', seconds: '' }]);
  assert.deepEqual(props.value, { minutes: '15', seconds: '0' });
});
test('legacy fractional seconds remain representable by the native input step', () => {
  const html = renderToStaticMarkup(React.createElement(DurationInput, { ...props, value: { minutes: '35791', seconds: '23.647' } }));
  const seconds = html.match(/<input\b[^>]+>/g)[1]; assert.match(seconds, /step="0\.001"/); assert.match(seconds, /value="23\.647"/);
  const scientific = renderToStaticMarkup(React.createElement(DurationInput, { ...props, value: { minutes: '0', seconds: '1e-3' } }));
  assert.match(scientific.match(/<input\b[^>]+>/g)[1], /step="0\.001"/);
});
test('disabled and invalid state apply to both controls without hidden value changes', () => {
  const html = renderToStaticMarkup(React.createElement(DurationInput, { ...props, disabled: true, invalid: true }));
  for (const input of html.match(/<input\b[^>]+>/g)) { assert.match(input, /disabled=""/); assert.match(input, /aria-invalid="true"/); }
  assert.match(html, /data-invalid=""/); assert.doesNotMatch(html, /<button|<form|<script/);
});
test('duration InputGroup stays together on narrow screens and scoped styles retain focus and error feedback', async () => {
  const css = await readFile(new URL('../client/styles.css', import.meta.url), 'utf8');
  assert.match(css, /\.dream-settings-input-group\.dream-settings-duration\s*\{[^}]*flex-wrap: nowrap/);
  assert.match(css, /\.dream-settings-input-group\.dream-settings-duration > \.dream-settings-duration-input\s*\{[^}]*flex: 1 1 0;[^}]*min-width: 0/);
  assert.match(css, /\.dream-settings-duration:focus-within/); assert.match(css, /\.dream-settings-duration\[data-invalid\]/);
});
