import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { executeScan, ScannerWorker, scannerApi, type StoredScannerTask } from './job-scanner.js';
import { FileScannerStore, PostgresScannerStore } from './scanner-store.js';
import { FileBuildQueueStore, PostgresBuildQueueStore } from './build-queue.js';
import { OpenAIJobScorer } from './job-scorer.js';
import { TOKEN_ACTIONS } from '../shared/token-actions.js';
import type { BuildProviders } from './build-deploy.js';
import type { JobScorer } from './job-scorer.js';
import type { Database } from './saas/database.js';

const scope = () => ({userId:randomUUID(),workspaceId:randomUUID(),websiteId:randomUUID()});
const summary = (id:number) => ({id,jobNumber:String(id),jobName:'Plumbing',descriptionPreview:`Repair ${id}`,status:'Completed',location:{city:'Rome',state:'GA',zip:'30161'},workSummary:'The technician found a leaking valve, removed the damaged part and installed a replacement valve. The job notes confirm the leak was resolved.'});
function providers(ids:number[], existing:number[] = []) {
  const charges:string[]=[];
  const p:BuildProviders = {
    serviceTitan: {
      getScannerJobs:async(page)=>({data:page===1?ids.map(summary):[],page,pageSize:25,hasMore:false}),
      getJobs:async()=>{throw new Error('Scanner must not use browser date filters');}, getJob:async(id)=>summary(id),
      getJobDetails:async(id)=>({job:{id,jobNumber:String(id),locationId:1,jobTypeId:2,jobStatus:'Completed'},summary:summary(id),history:[],attachments:[{id:'photo',fileName:'work.jpg',contentType:'image/jpeg'}]}),
      getJobImage:async()=>{throw new Error('Scanning must not download original images');},
    },
    wordpress:{getPluginStatus:async()=>({state:'current',requiredVersion:'1.20.2',seoGeneratorVersion:13}),getStatuses:async(jobIds)=>Object.fromEntries(jobIds.map(id=>[id,existing.includes(id)?{state:'exists',label:'Published'}:{state:'not_found',label:'None'}])),getStatus:async()=>({state:'not_found',label:'None'}),pushJob:async()=>{throw new Error('Only the existing build worker may write drafts');},regenerateJob:async()=>{throw new Error('unused');},updateStatus:async()=>{throw new Error('Scanning must not publish');}},
    copyGenerator:{generate:async()=>{throw new Error('Only build worker generates post copy');}},
    spendJobToken:async(action,operation)=>{charges.push(action);return operation();},
  };
  return {p,charges};
}
async function fileFixture() {
  const dir=await mkdtemp(join(tmpdir(),'job-scanner-'));
  const store=new FileScannerStore(join(dir,'scans.json'));const queue=new FileBuildQueueStore(join(dir,'builds.json'));
  return {dir,store,queue,close:()=>rm(dir,{recursive:true,force:true})};
}

test('scanner finds ten qualified jobs, skips existing WordPress posts, ranks top five, and enqueues drafts only',async()=>{
  const f=await fileFixture();try{
    const s=scope();await f.store.enqueue(s,randomUUID());const task=(await f.store.claim())!;
    const {p,charges}=providers([99,...Array.from({length:15},(_,i)=>i+1)],[99]);let ratings=0;
    await executeScan(task,p,{rate:async()=>({score:70+ratings++,reason:'Specific documented repair and outcome.'})},f.store,f.queue);
    assert.equal(task.scanned,11);assert.equal(task.rated,10);assert.equal(task.stopReason,'ten_candidates');
    assert.deepEqual(task.selected.map(item=>item.jobId),[10,9,8,7,6]);assert.equal(task.state,'drafting');
    assert.deepEqual(charges,['job_scan']);assert.equal(TOKEN_ACTIONS.job_scan.cost,1);assert.equal(TOKEN_ACTIONS.build.cost,1);
    assert.equal((await f.queue.list(s,task.selected.map(item=>item.jobId))).length,5);
    for(let i=0;i<5;i++){const build=(await f.queue.claim())!;build.state='succeeded';build.result={state:'exists',label:'Draft',postStatus:'draft',postId:i+1};await f.queue.save(build);}
    const result=await scannerApi(s,f.store,f.queue).latest();assert.equal(result?.state,'succeeded');assert(result?.selected.every(item=>item.build?.result?.postStatus==='draft'));
    assert(!JSON.stringify(result).includes(s.userId));
  }finally{await f.close();}
});

test('empty/exhausted scans charge only the scan; AI failure queues no drafts and is a safe billing failure',async()=>{
  const f=await fileFixture();try{
    const s=scope();const api=scannerApi(s,f.store,f.queue);await api.start(randomUUID());const task=(await f.store.claim())!;
    const empty=providers([]);await executeScan(task,empty.p,{rate:async()=>{throw new Error('unused');}},f.store,f.queue);
    assert.equal(task.state,'succeeded');assert.equal(task.stopReason,'exhausted');assert.deepEqual(empty.charges,['job_scan']);
    await api.start(randomUUID());const next=(await f.store.claim())!;const failing=providers([1]);
    await assert.rejects(executeScan(next,failing.p,{rate:async()=>{throw new Error('AI unavailable');}},f.store,f.queue),error=>(error as Error).name==='TokenOperationSafeFailure');
    assert.equal(await f.queue.claim(),undefined);
  }finally{await f.close();}
});

test('scanner limits AI ratings, ignores missing/unknown WordPress statuses, and preserves queued results across restarts',async()=>{
  const f=await fileFixture();try{
    const s=scope();const id=randomUUID();await f.store.enqueue(s,id);
    const reloaded=new FileScannerStore(join(f.dir,'scans.json'));assert.equal((await reloaded.latest(s))?.id,id);
    const task=(await reloaded.claim())!;const {p}=providers([]);
    p.serviceTitan.getScannerJobs=async(page)=>({data:Array.from({length:25},(_,i)=>summary((page-1)*25+i+1)),page,pageSize:25,hasMore:true});
    await executeScan(task,p,{rate:async()=>({score:20,reason:'Too generic for a distinct post.'})},reloaded,f.queue);
    assert.equal(task.rated,40);assert.equal(task.stopReason,'limits');assert.equal(task.selected.length,0);
    const other=scope();await f.store.enqueue(other,randomUUID());const unknown=(await f.store.claim())!;const sample=providers([1]);sample.p.wordpress.getStatuses=async()=>({});
    let rated=false;await executeScan(unknown,sample.p,{rate:async()=>{rated=true;return{score:90,reason:'Should not run'};}},f.store,f.queue);assert.equal(rated,false);
  }finally{await f.close();}
});

test('worker handles execution failures without replay and file scan scope/idempotency prevent duplicate runs',async()=>{
  const f=await fileFixture();try{
    const s=scope();const id=randomUUID();const [a,b]=await Promise.all([f.store.enqueue(s,id),f.store.enqueue(s,randomUUID())]);assert.equal(a.id,b.id);
    assert.equal(await f.store.latest({...s,websiteId:randomUUID()}),undefined);
    let executed=0;const worker=new ScannerWorker(f.store,async()=>{executed++;throw new Error('Stopped safely');});
    await worker.runOnce();await worker.runOnce();assert.equal(executed,1);assert.equal((await f.store.latest(s))?.state,'failed');
    assert.equal((await f.store.enqueue(s,id)).state,'failed');
  }finally{await f.close();}
});

test('PostgreSQL scanner claims are durable, scoped and deduplicated; exact build IDs cannot cross scopes',async()=>{
  const pg=new PGlite();try{
    await pg.exec('CREATE TABLE workspaces(id uuid PRIMARY KEY);CREATE TABLE websites(id uuid PRIMARY KEY);');
    await pg.exec(await readFile('migrations/006_build_deploy_queue.sql','utf8'));await pg.exec(await readFile('migrations/013_job_scanner.sql','utf8'));
    let tail=Promise.resolve();
    const db:Database={transaction:async(_user,action)=>{const previous=tail;let release!:()=>void;tail=new Promise<void>(resolve=>{release=resolve;});await previous;try{await pg.exec('BEGIN');const result=await action({query:async(sql,values)=>({rows:(await pg.query(sql,values)).rows as never[]})});await pg.exec('COMMIT');return result;}catch(error){await pg.exec('ROLLBACK');throw error;}finally{release();}}};
    const s=scope();await pg.query('INSERT INTO workspaces VALUES($1)',[s.workspaceId]);await pg.query('INSERT INTO websites VALUES($1)',[s.websiteId]);
    const store=new PostgresScannerStore(db),queue=new PostgresBuildQueueStore(db);
    const [first,duplicate]=await Promise.all([store.enqueue(s,randomUUID()),store.enqueue(s,randomUUID())]);assert.equal(first.id,duplicate.id);
    assert.equal((await store.claim())?.id,first.id);assert.equal(await store.claim(),undefined);
    assert.equal(await store.latest({...s,workspaceId:randomUUID()}),undefined);
    await pg.query("UPDATE job_scanner_tasks SET updated_at=now()-interval '10 minutes' WHERE id=$1",[first.id]);await store.claim();assert.equal((await store.latest(s))?.state,'failed');
    const build=await queue.enqueue(s,1);assert.equal((await queue.listById(s,[build.id])).length,1);assert.equal((await queue.listById({...s,websiteId:randomUUID()},[build.id])).length,0);
  }finally{await pg.close();}
});

test('AI scorer uses strict schema without search and rejects malformed or failed ratings',async()=>{
  let request:Record<string,unknown>={};
  const scorer=new OpenAIJobScorer({apiKey:'private',model:'gpt-6-luna',apiBaseUrl:'https://example.test'},async(_url,init)=>{request=JSON.parse(String(init?.body));return new Response(JSON.stringify({output_text:JSON.stringify({score:85,reason:'Documented repair with a clear outcome.'})}));});
  assert.equal((await scorer.rate(summary(1))).score,85);assert.equal(request.store,false);assert.equal(request.tools,undefined);
  const bad=new OpenAIJobScorer({apiKey:'private',model:'test',apiBaseUrl:'https://example.test'},async()=>new Response(JSON.stringify({output_text:'{"score":101,"reason":"invalid"}'})));
  await assert.rejects(bad.rate(summary(1)),/AI content rating failed/);
});
