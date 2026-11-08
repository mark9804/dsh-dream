import { build } from 'esbuild';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const result = await build({ entryPoints: ['client/index.tsx'], bundle: true, write: false, platform: 'browser', target: ['es2022'], format: 'cjs', jsx: 'automatic',
  external: ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client'], loader: { '.css': 'text' },
  define: { 'process.env.NODE_ENV': '"production"' }, minify: true, legalComments: 'eof', metafile: true });
const imports = Object.values(result.metafile.outputs).flatMap(output => output.imports.filter(item => item.external).map(item => item.path));
if (imports.some(path => !['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client'].includes(path))) throw new Error(`Unexpected browser runtime imports: ${imports.join(', ')}`);
const output = 'window.__ModuleLoader__.load({id:"dsh-dream",factory(require){const module={exports:{}};const exports=module.exports;\n' + result.outputFiles[0].text + '\nreturn module.exports;}});\n';
await mkdir('web', { recursive: true });
await writeFile('web/client.js', output);
// Preserve all bundled third-party licenses, including Base UI and Floating UI.
const packages = ['@base-ui/react', '@base-ui/utils', '@babel/runtime', '@floating-ui/react-dom', '@floating-ui/dom', '@floating-ui/core', '@floating-ui/utils', 'tabbable', 'use-sync-external-store'];
let notices = 'DSH-Dream browser bundle third-party notices\nReact and React DOM are provided by the DSH shell, not bundled.\n\n=== shadcn/ui adapted Base UI components ===\n' + await readFile('client/SHADCN_LICENSE.txt', 'utf8') + '\n\n';
for (const pkg of packages) {
  const base = resolve('node_modules', pkg); let license;
  for (const name of ['LICENSE', 'LICENSE.md', 'LICENSE.txt']) { try { license = await readFile(resolve(base, name), 'utf8'); break; } catch (error) { if (error.code !== 'ENOENT') throw error; } }
  if (license) notices += `=== ${pkg} ===\n${license}\n\n`;
}
await writeFile('THIRD_PARTY_NOTICES.txt', notices);
console.log(`Client bundle: ${Buffer.byteLength(output)} bytes; shared runtime imports: ${[...new Set(imports)].join(', ')}`);
