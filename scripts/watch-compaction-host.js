import assert from 'node:assert/strict';
import { watch } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
const root=resolve(process.argv[2]??'');assert.ok(root.includes('/tests/.tmp/compaction-host-'));
await new Promise((resolvePromise,reject)=>{
  let done=false,busy=false,dirty=false;
  const finish=(value,error)=>{if(done)return;done=true;clearTimeout(timer);watcher.close();error?reject(error):(console.log(JSON.stringify(value)),resolvePromise());};
  async function inspect(){dirty=true;if(busy||done)return;busy=true;try{do{dirty=false;for(const file of['complete.json','failure.json']){try{const text=await readFile(join(root,file),'utf8'),value=JSON.parse(text);finish({file,...value});return;}catch(e){if(e.code!=='ENOENT'&&!(e instanceof SyntaxError))throw e;}}}while(dirty&&!done);}catch(e){finish(undefined,e);}finally{busy=false;}}
  const watcher=watch(root,(_event,name)=>{if(name==='complete.json'||name==='failure.json')void inspect();});
  const timer=setTimeout(()=>finish({state:'observation-timeout-not-cancellation'}),7200000);void inspect();
});
