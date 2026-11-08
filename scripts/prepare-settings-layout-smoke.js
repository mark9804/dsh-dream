import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
const root = await mkdtemp(join(resolve(import.meta.dirname, '../tests/.tmp'), 'settings-layout-host-'));
const bundle = join(root, 'bundle'), name = `dsh-dream-layout-smoke-${randomUUID().slice(0, 8)}`; await mkdir(bundle);
const expected = process.argv[2] ? JSON.parse(await readFile(process.argv[2], 'utf8')) : null;
const code = `import{createHash}from'node:crypto';import{writeFile}from'node:fs/promises';import{join}from'node:path';
export const inject=['configEditor','connection','clientModules'];
export function apply(ctx){return ctx.effect(()=>{
 const root=${JSON.stringify(root)},expected=${JSON.stringify(expected)},hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
 let done=false,pending=Promise.resolve();
 async function run(){
  const entry=ctx.configEditor.entries().find(e=>e.options.id==='dsh-dream-configuration'),layer=ctx.configEditor.configuration().find(r=>r.entry===entry);
  if(!entry||!layer)throw Error('Dream configuration owner unavailable');
  const identity={rawHash:hash(entry.options.config),inheritedHash:hash(layer.inherited),enabled:entry.options.config?.enabled===true};
  await writeFile(join(root,'identity.json'),JSON.stringify(identity,null,2),{flag:'wx'});
  if(!expected)return;
  const handler=ctx.connection.createSharedFetchHandler('/api'),response=await handler.fetch(new Request('http://localhost/api/dsh-dream/read',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'}),ctx.connection.browserPeer);
  const body=await response.json(),readable=response.status===200&&body.ok===true;
  const row=ctx.clientModules.graph().entries.find(e=>e.id==='dsh-dream');if(!row)throw Error('Client entry unavailable');
  const served=await ctx.clientModules.fetchBundle(new Request(new URL(row.url,'http://localhost'))),client=await served.text();
  const group=name=>client.indexOf('"data-settings-group":"'+name+'"');
  const positions={basic:group('basic'),daily:group('daily'),setup:group('setup'),advanced:group('advanced')};
  const ordered=positions.basic>=0&&positions.basic<positions.daily&&positions.daily<positions.setup&&positions.setup<positions.advanced;
  const markers={basic:client.includes('basicDescription:'),daily:client.includes('dailyDescription:'),setup:client.includes('setupDescription:'),filePicker:client.includes('pick-file'),baseSwitch:client.includes('dream-settings-switch-thumb')};
  const preserved=identity.rawHash===expected.rawHash&&identity.inheritedHash===expected.inheritedHash;
  await writeFile(join(root,'verification.json'),JSON.stringify({state:preserved&&readable&&served.status===200&&ordered&&Object.values(markers).every(Boolean)?'completed':'requires-attention',configPreserved:preserved,enabled:identity.enabled,settingsReadable:readable,servedClientStatus:served.status,groupOrderVerified:ordered,markers,servedSha256:createHash('sha256').update(client).digest('hex'),noSettingsWrites:true,noMemoryReads:true,noModelCalls:true,visualVerified:false},null,2),{flag:'wx'});
 }
 const off=ctx.on('tools/execute',async(exec,next)=>{if(!done&&exec.name!=='plugin_manager'){done=true;pending=run().catch(error=>writeFile(join(root,'failure.json'),JSON.stringify({error:String(error.stack??error)}),{flag:'wx'}));}return next();});
 return async()=>{off();await pending;};
});}
`;
await writeFile(join(bundle, 'index.js'), code);
await writeFile(join(bundle, 'package.json'), JSON.stringify({ name, version:'0.1.0', private:true, type:'module', exports:{'.':'./index.js'}, dsh:{bundle:{patch:'./cordis.patch.yml'}} }, null, 2));
await writeFile(join(bundle, 'cordis.patch.yml'), `- insert:\n    - id: ${name}\n      name: ${name}\n`);
await writeFile(join(root, 'manifest.json'), JSON.stringify({root,bundle,name,metadataException:'One-off internal verification without final visible controls',purpose:'Verify configured state preserved and actual served settings Client includes requested groups; no settings or memory writes'},null,2));
console.log(JSON.stringify({root,bundle,name},null,2));
