import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
const root = await mkdtemp(join(resolve(import.meta.dirname, '../tests/.tmp'), 'settings-duration-host-'));
const bundle = join(root, 'bundle'), name = `dsh-dream-duration-smoke-${randomUUID().slice(0, 8)}`; await mkdir(bundle);
const expected = process.argv[2] ? JSON.parse(await readFile(process.argv[2], 'utf8')) : null;
const code = `import{createHash}from'node:crypto';import{readFile,writeFile}from'node:fs/promises';import{join}from'node:path';
export const inject=['configEditor','connection','clientModules'];
export function apply(ctx){return ctx.effect(()=>{
 const root=${JSON.stringify(root)},expected=${JSON.stringify(expected)},hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
 let done=false,pending=Promise.resolve();
 async function run(){
  const entry=ctx.configEditor.entries().find(e=>e.options.id==='dsh-dream-configuration'),layer=ctx.configEditor.configuration().find(r=>r.entry===entry);
  if(!entry||!layer)throw Error('Dream configuration owner unavailable');
  const handler=ctx.connection.createSharedFetchHandler('/api'),response=await handler.fetch(new Request('http://localhost/api/dsh-dream/read',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'}),ctx.connection.browserPeer),body=await response.json();
  if(response.status!==200||body.ok!==true)throw Error('Dream settings read unavailable');
  const view=body.value,raw=entry.options.config,jobIds=view.status.jobs?.map(j=>j.jobId)??[];
  const jobHashes={};for(const id of jobIds){if(!/^[a-zA-Z0-9-]+$/.test(id))throw Error('Unsupported job identity');jobHashes[id]=createHash('sha256').update(await readFile(join(view.config.stateRoot,'jobs',id+'.json'))).digest('hex');}
  const identity={rawHash:hash(raw),inheritedHash:hash(layer.inherited),enabled:raw.enabled===true,configuredTimeoutMs:view.config.timeoutMs,configuredDreamTimeoutMs:view.config.dreamTimeoutMs,sourceJobHashes:jobHashes};
  await writeFile(join(root,'identity.json'),JSON.stringify(identity,null,2),{flag:'wx'});if(!expected)return;
  const row=ctx.clientModules.graph().entries.find(e=>e.id==='dsh-dream');if(!row)throw Error('Dream Client unavailable');
  const served=await ctx.clientModules.fetchBundle(new Request(new URL(row.url,'http://localhost'))),client=await served.text();
  const controls={group:client.includes('dream-settings-duration'),inputGroup:client.includes('dream-settings-input-group-control'),minuteUnit:client.includes('minutesLabel'),secondUnit:client.includes('secondsLabel'),diagnostics:client.includes('data-generation-diagnostics')};
  const configPreserved=identity.rawHash===expected.rawHash&&identity.inheritedHash===expected.inheritedHash&&identity.enabled===expected.enabled;
  const tasksPreserved=hash(jobHashes)===hash(expected.sourceJobHashes);
  await writeFile(join(root,'verification.json'),JSON.stringify({state:configPreserved&&tasksPreserved&&served.status===200&&view.defaults.timeoutMs===900000&&Object.values(controls).every(Boolean)?'completed':'requires-attention',configPreserved,tasksPreserved,enabled:identity.enabled,configuredTimeoutMs:view.config.timeoutMs,configuredDreamTimeoutMs:view.config.dreamTimeoutMs,defaultTimeoutMs:view.defaults.timeoutMs,defaultDreamTimeoutMs:view.defaults.dreamTimeoutMs,settingsReadable:true,servedClientStatus:served.status,controls,servedSha256:createHash('sha256').update(client).digest('hex'),noSettingsWrites:true,noTaskRetry:true,noModelCalls:true,noMemoryContentReads:true,visualVerified:false},null,2),{flag:'wx'});
 }
 const off=ctx.on('tools/execute',async(exec,next)=>{if(!done&&exec.name!=='plugin_manager'){done=true;pending=run().catch(error=>writeFile(join(root,'failure.json'),JSON.stringify({error:String(error.stack??error)}),{flag:'wx'}));}return next();});
 return async()=>{off();await pending;};
});}
`;
await writeFile(join(bundle, 'index.js'), code);
await writeFile(join(bundle, 'package.json'), JSON.stringify({ name, version:'0.1.0', private:true, type:'module', exports:{'.':'./index.js'}, dsh:{bundle:{patch:'./cordis.patch.yml'}} }, null, 2));
await writeFile(join(bundle, 'cordis.patch.yml'), `- insert:\n    - id: ${name}\n      name: ${name}\n`);
await writeFile(join(root,'manifest.json'),JSON.stringify({root,bundle,name,metadataException:'Disposable internal verification without final visible UI',purpose:'Verify actual served minute-second Client, default timeout and unchanged config/tasks without retry or writes'},null,2));
console.log(JSON.stringify({root,bundle,name},null,2));
