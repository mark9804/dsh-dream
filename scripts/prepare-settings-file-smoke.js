import { mkdir, mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
const root = await mkdtemp(join(resolve(import.meta.dirname, '../tests/.tmp'), 'settings-file-host-'));
const bundle = join(root, 'bundle'), name = `dsh-dream-file-smoke-${randomUUID().slice(0,8)}`; await mkdir(bundle);
const expected = process.argv[2] ? JSON.parse(await readFile(process.argv[2], 'utf8')) : null;
const code = `import{createHash}from'node:crypto';import{writeFile}from'node:fs/promises';import{join}from'node:path';
export const inject=['configEditor','connection','clientModules'];
export function apply(ctx){return ctx.effect(()=>{
 const root=${JSON.stringify(root)},expected=${JSON.stringify(expected)},hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
 let done=false,pending=Promise.resolve();
 async function run(){
  const entry=ctx.configEditor.entries().find(e=>e.options.id==='dsh-dream-configuration'),layer=ctx.configEditor.configuration().find(r=>r.entry===entry);
  if(!entry||!layer)throw Error('Configuration owner unavailable');
  const identity={rawHash:hash(entry.options.config),inheritedHash:hash(layer.inherited),enabled:entry.options.config?.enabled===true};
  await writeFile(join(root,'identity.json'),JSON.stringify(identity,null,2),{flag:'wx'});
  if(!expected)return;
  const handler=ctx.connection.createSharedFetchHandler('/api');
  // Invalid payload verifies the registered route/guard without opening OS UI.
  const response=await handler.fetch(new Request('http://localhost/api/dsh-dream/pick-file',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({notAnAllowedArgument:true})}),ctx.connection.browserPeer);
  const body=await response.json(),routeVerified=response.status===400&&body.error?.code==='INVALID_REQUEST';
  const row=ctx.clientModules.graph().entries.find(e=>e.id==='dsh-dream');if(!row)throw Error('Client entry unavailable');
  const served=await ctx.clientModules.fetchBundle(new Request(new URL(row.url,'http://localhost'))),client=await served.text();
  const markers={filePicker:client.includes('pick-file'),fileButton:client.includes('browseFile:'),workingDirectory:client.includes('stateLocationHelp:')};
  const nativeAvailable=process.platform==='darwin'&&ctx.get('directoryPicker')?.capability().kind==='native'&&typeof ctx.get('subprocess')?.spawn==='function';
  const preserved=identity.rawHash===expected.rawHash&&identity.inheritedHash===expected.inheritedHash;
  await writeFile(join(root,'verification.json'),JSON.stringify({state:preserved&&routeVerified&&served.status===200&&Object.values(markers).every(Boolean)&&nativeAvailable?'completed':'requires-attention',configPreserved:preserved,enabled:identity.enabled,routeVerified,nativeAvailable,servedClientStatus:served.status,markers,servedSha256:hash(client),noOSDialogsOpened:true,noMemoryReads:true,noSettingsWrites:true,noModelCalls:true,interactiveDialogVerified:false},null,2),{flag:'wx'});
 }
 const off=ctx.on('tools/execute',async(exec,next)=>{if(!done&&exec.name!=='plugin_manager'){done=true;pending=run().catch(error=>writeFile(join(root,'failure.json'),JSON.stringify({error:String(error.stack??error)}),{flag:'wx'}));}return next();});
 return async()=>{off();await pending;};
});}
`;
await writeFile(join(bundle,'index.js'),code);
await writeFile(join(bundle,'package.json'),JSON.stringify({name,version:'0.1.0',private:true,type:'module',exports:{'.':'./index.js'},dsh:{bundle:{patch:'./cordis.patch.yml'}}},null,2));
await writeFile(join(bundle,'cordis.patch.yml'),`- insert:\n    - id: ${name}\n      name: ${name}\n`);
await writeFile(join(root,'manifest.json'),JSON.stringify({root,bundle,name,metadataException:'Disposable bounded verification fixture, no final UI surface',purpose:'Hash own settings and verify file selector endpoint guard and served Client without opening a dialog or reading memories'},null,2));
console.log(JSON.stringify({root,bundle,name},null,2));
