// Document contract checks only: no Host, model or profile operations.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const root=resolve(import.meta.dirname,'..');
const { validateConfig }=await import('../dist/config.js');
const defaultConfig=validateConfig({sessionId:'synthetic-only',memoryRoot:resolve(root,'tests/.tmp/design-check-memory'),stateRoot:resolve(root,'tests/.tmp/design-check-state')});
const keys=[...Object.keys(defaultConfig),'personaPath','dreamMood'];assert.equal(new Set(keys).size,30);
const docs=['docs/settings-ui-shadcn-2026-11-06.md','docs/compatibility-dsh-0.2.2-rc1-2026-11-06.md'];
const documents=await Promise.all(docs.map(path=>readFile(resolve(root,path),'utf8')));
const ui=documents[0],configurationTables=ui.slice(ui.indexOf('### A.'),ui.indexOf('## 3.'));
for(const key of keys){const rows=configurationTables.split('\n').filter(line=>line.startsWith('|')&&line.split('|')[2]?.trim()==='`'+key+'`');assert.equal(rows.length,1,'Exactly one row for configuration field: '+key);}
for(const text of documents){let columns;for(const line of text.split('\n')){if(!line.startsWith('|')){columns=undefined;continue;}columns??=line.split('|').length;assert.equal(line.split('|').length,columns,'Consistent Markdown table columns: '+line);}
  for(const match of text.matchAll(/\]\(<([^>]+)>\)/g)){const target=match[1];if(target.startsWith('https:'))continue;const path=target.split('#')[0],doc=docs[documents.indexOf(text)];if(path.startsWith('/'))continue;await readFile(resolve(root,doc,'..',path));}
}
const links=new Map([...ui.matchAll(/^\[([^\]]+)\]: (https:\/\/\S+)$/gm)].map(m=>[m[1],m[2]]));
for(const match of ui.matchAll(/\]\[([^\]]+)\]/g))assert.ok(links.has(match[1]),'Missing component reference: '+match[1]);
console.log(JSON.stringify({configFields:30,exactlyOneTableRowPerField:true,documents:docs,workspaceLinksReadable:true,installedHostLinksCheckedSeparately:'Host read tool; app.asar is not an ordinary shell filesystem',componentReferences:links.size,meaning:'Markdown completeness/link checks only; no UI or runtime compatibility claim'},null,2));
