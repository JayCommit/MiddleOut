// Run only in the validation image on a disposable 128 MiB tmpfs DATA_DIR.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
const writer = spawnSync(
  process.execPath,
  [
    "--experimental-strip-types",
    "--input-type=module",
    "-e",
    `
import * as q from './src/lib/storage/queries.server.ts';import {getPglite,getSql} from './src/lib/db.ts';import {writeFile,unlink} from 'node:fs/promises';
await q.createBucket('disk-user','disk-bucket',false);await q.putBytes('disk-user','disk-bucket','sentinel',Buffer.from('must survive'),'text/plain',{});await(await getPglite()).syncToFs();
const padding=process.env.DATA_DIR+'/pressure-padding';let failed=false;
await writeFile(padding,Buffer.alloc(80*1024*1024));
try { for(let i=0;i<8;i++){const result=await q.putBytes('disk-user','disk-bucket','fill-'+i,Buffer.alloc(8*1024*1024),'application/octet-stream',{});if(!result.ok)throw Error(result.code);await(await getPglite()).syncToFs();} }
catch(error){if(!/ENOSPC|No space left|disk.*full/i.test(String(error)) && error.errno!==28 && error.code!=='ENOSPC')throw error;failed=true;console.log('Disk pressure write failed as expected');}
finally {await unlink(padding).catch(()=>{});}
if(!failed)throw Error('Test did not reach disk pressure');await(await getPglite()).close();
`,
  ],
  { stdio: "inherit", env: process.env, timeout: 120000 },
);
assert.equal(writer.status, 0, "Disk pressure writer failed recovery");
const reader = spawnSync(
  process.execPath,
  [
    "--experimental-strip-types",
    "--input-type=module",
    "-e",
    `
import * as q from './src/lib/storage/queries.server.ts';import {getPglite,getSql} from './src/lib/db.ts';const result=await q.readObjectFor('disk-user','disk-bucket','sentinel');if(result.object.bytes.toString()!=='must survive')throw Error('Lost committed data');const sql=await getSql();const rows=await sql\`select key,size from mo_objects where complete=true and bucket_id=(select id from mo_buckets where name='disk-bucket')\`;for(const row of rows){const object=await q.readObjectFor('disk-user','disk-bucket',row.key);if(object.object.bytes.length!==row.size)throw Error('Partial committed object');}await(await getPglite()).close();
`,
  ],
  { stdio: "inherit", env: process.env, timeout: 120000 },
);
assert.equal(reader.status, 0, "Committed data failed restart verification after disk pressure");
console.log(
  "PASS: full-filesystem failure preserves committed bytes and complete-object consistency after restart.",
);
