import { scannerSkipReason } from './scanner-rating.js';
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
    wordpress:{getPluginStatus:async()=>({state:'current',requiredVersion:'1.20.3',seoGeneratorVersion:13}),getStatuses:async(jobIds)=>Object.fromEntries(jobIds.map(id=>[id,existing.includes(id)?{state:'exists',label:'Published'}:{state:'not_found',label:'None'}])),getStatus:async()=>({state:'not_found',label:'None'}),pushJob:async()=>{throw new Error('Only the existing build worker may write drafts');},regenerateJob:async()=>{throw new Error('unused');},updateStatus:async()=>{throw new Error('Scanning must not publish');}},
    copyGenerator:{generate:async()=>{throw new Error('Only build worker generates post copy');}},
    spendJobToken:async(action,operation)=>{charges.push(action);return operation();},
  };
  return {p,charges};
}
async function fileFixture(autoBuild = true) {
  const dir=await mkdtemp(join(tmpdir(),'job-scanner-'));
  const store=new FileScannerStore(join(dir,'scans.json'));const queue=new FileBuildQueueStore(join(dir,'builds.json'));
  const completed:number[]=[];
  const listById=queue.listById.bind(queue);
  if(autoBuild)queue.listById=async(scope,ids)=>{
    // Stand in for the independent durable build worker; scanner code must wait
    // for this completion before requesting details for a subsequent job.
    for(const item of await listById(scope,ids))if(item.state==='queued'){
      const build=(await queue.claim())!;assert.equal(build.id,item.id);
      build.state='succeeded';build.result={state:'exists',label:'Draft',postStatus:'draft',postId:build.jobId};await queue.save(build);completed.push(build.jobId);
    }
    return listById(scope,ids);
  };
  return {dir,store,queue,completed,close:()=>rm(dir,{recursive:true,force:true})};
}

test('scanner stops at five strong candidates and waits for each durable draft before checking the next job',async()=>{
  const f=await fileFixture();try{
    const s=scope();await f.store.enqueue(s,randomUUID());const task=(await f.store.claim())!;
    const {p,charges}=providers([99,...Array.from({length:15},(_,i)=>i+1)],[99]);let ratings=0;
    const getDetails=p.serviceTitan.getJobDetails.bind(p.serviceTitan);
    p.serviceTitan.getJobDetails=async id=>{assert.equal(f.completed.length,id-1,'prior draft must finish before the next job is checked');return getDetails(id);};
    await executeScan(task,p,{rate:async()=>({score:70+ratings++,reason:'Specific documented repair and outcome.'})},f.store,f.queue);
    assert.equal(task.scanned,6);assert.equal(task.rated,5);assert.equal(task.stopReason,'five_candidates');
    assert.deepEqual(task.selected.map(item=>item.jobId),[1,2,3,4,5]);assert.equal(task.state,'succeeded');assert.equal(task.scanFeeCharged,true);
    assert.deepEqual(charges,['job_scan']);assert.equal(TOKEN_ACTIONS.job_scan.cost,1);assert.equal(TOKEN_ACTIONS.build.cost,1);
    assert.equal((await f.queue.list(s,task.selected.map(item=>item.jobId))).length,5);
    const result=await scannerApi(s,f.store,f.queue).latest();assert.equal(result?.state,'succeeded');assert(result?.selected.every(item=>item.build?.result?.postStatus==='draft'));
    assert(!JSON.stringify(result).includes(s.userId));
  }finally{await f.close();}
});

test('empty/exhausted scans charge only the scan; AI failure queues no drafts after scan admission',async()=>{
  const f=await fileFixture();try{
    const s=scope();const api=scannerApi(s,f.store,f.queue);await api.start(randomUUID());const task=(await f.store.claim())!;
    const empty=providers([]);await executeScan(task,empty.p,{rate:async()=>{throw new Error('unused');}},f.store,f.queue);
    assert.equal(task.state,'succeeded');assert.equal(task.stopReason,'exhausted');assert.deepEqual(empty.charges,['job_scan']);
    await api.start(randomUUID());const next=(await f.store.claim())!;const failing=providers([1]);
    await assert.rejects(executeScan(next,failing.p,{rate:async()=>{throw new Error('AI unavailable');}},f.store,f.queue),/AI unavailable/);
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
    const claimed=(await store.claim())!;assert.equal(claimed.id,first.id);assert.equal(await store.claim(),undefined);
    assert.equal(await store.cancel({...s,websiteId:randomUUID()},first.id),undefined);
    await store.cancel(s,first.id);await store.save(claimed);
    assert.equal((await store.get(s,first.id))?.cancelRequested,true,'stale PostgreSQL worker saves must retain cancellation');
    assert.equal(await store.latest({...s,workspaceId:randomUUID()}),undefined);
    await pg.query("UPDATE job_scanner_tasks SET updated_at=now()-interval '10 minutes' WHERE id=$1",[first.id]);await store.claim();assert.equal((await store.latest(s))?.state,'failed');
    const build=await queue.enqueue(s,1);assert.equal((await queue.listById(s,[build.id])).length,1);assert.equal((await queue.listById({...s,websiteId:randomUUID()},[build.id])).length,0);
    assert.equal(await queue.cancelQueued({...s,websiteId:randomUUID()},build.id),false);
    assert.equal(await queue.cancelQueued(s,build.id),true);assert.equal(await queue.claim(),undefined);
    const next=await store.enqueue(s,randomUUID());await store.cancel(s,next.id);assert.equal((await store.get(s,next.id))?.stopReason,'canceled');assert.equal(await store.claim(),undefined);
  }finally{await pg.close();}
});

test('AI scorer uses strict schema without search and rejects malformed or failed ratings',async()=>{
  let request:Record<string,unknown>={};
  const scorer=new OpenAIJobScorer({apiKey:'private',model:'gpt-6-luna',apiBaseUrl:'https://example.test'},async(_url,init)=>{request=JSON.parse(String(init?.body));return new Response(JSON.stringify({output_text:JSON.stringify({score:85,reason:'Documented repair with a clear outcome.'})}));});
  assert.equal((await scorer.rate(summary(1))).score,85);assert.equal(request.store,false);assert.equal(request.tools,undefined);
  const instructions=String(request.instructions);
  assert.match(instructions,/clear service or customer issue \(0-30\)/);
  assert.match(instructions,/useful project details[\s\S]*?\(0-30\)/);
  assert.match(instructions,/local relevance[\s\S]*?\(0-20\)/);
  assert.match(instructions,/distinct, helpful page \(0-20\)/);
  assert.match(instructions,/Completed work and documented outcomes strengthen the score but are not mandatory/);
  assert.match(instructions,/Generic labels plus a city alone are insufficient/);
  const bad=new OpenAIJobScorer({apiKey:'private',model:'test',apiBaseUrl:'https://example.test'},async()=>new Response(JSON.stringify({output_text:'{"score":101,"reason":"invalid"}'})));
  await assert.rejects(bad.rate(summary(1)),/AI content rating failed/);
});

test('scanner rates concise service records and uses the same 70-point acceptance threshold', async()=>{
  const f=await fileFixture();
  try {
    const s=scope();await f.store.enqueue(s,randomUUID());const task=(await f.store.claim())!;
    const {p}=providers([1,2,3]);
    const original=p.serviceTitan.getJobDetails.bind(p.serviceTitan);
    p.serviceTitan.getJobDetails=async id=>{
      const details=await original(id);
      return {...details,summary:{...details.summary,workSummary:'',summaryText:id===1?'Tankless heater maintenance; descaled heat exchanger.':id===2?'Service call.':'Routine furnace inspection; filter and airflow check.'}};
    };
    const seen:string[]=[];
    await executeScan(task,p,{rate:async source=>{
      seen.push(source.summaryText!);
      // Fixed editorial decisions exercise routing/thresholds without relying
      // on nondeterministic live AI responses in a regression test.
      return {score:source.summaryText==='Service call.'?40:70,reason:'Fixture editorial decision.'};
    }},f.store,f.queue);
    assert.equal(task.rated,3,'all short records reach the scorer for semantic evaluation');
    assert.equal(seen.length,3);
    assert.deepEqual(task.candidates.map(item=>item.jobId),[1,3]);
    assert.equal(task.candidates[0]!.score,70);
  } finally {await f.close();}
});

test('scanner retains the attachment requirement while letting the model assess short context',async()=>{
  const {p}=providers([1]);
  const details=await p.serviceTitan.getJobDetails(1);
  const brief={...details,summary:{...details.summary,summaryText:'Annual furnace inspection.',workSummary:''}};
  assert.equal(scannerSkipReason(brief),undefined);
  assert.match(scannerSkipReason({...brief,attachments:[]})!,/no attachments/);
});

test('canceling a queued scan is scoped, idempotent, and charges no tokens',async()=>{
  const f=await fileFixture(false);try{
    const s=scope(),api=scannerApi(s,f.store,f.queue);const scan=await api.start(randomUUID());
    await assert.rejects(scannerApi({...s,websiteId:randomUUID()},f.store,f.queue).cancel(scan.id),/not found/);
    const canceled=await api.cancel(scan.id);assert.equal(canceled.stopReason,'canceled');assert.equal(canceled.scanFeeCharged,undefined);
    assert.equal((await api.cancel(scan.id)).stopReason,'canceled');assert.equal(await f.store.claim(),undefined);
    const next=await api.start(randomUUID());assert.notEqual(next.id,scan.id);
    await api.cancel(scan.id);assert.equal((await f.store.get(s,next.id))!.state,'queued','old cancel must not stop a newer scan');
  }finally{await f.close();}
});

test('cancellation during evaluation survives a stale progress save and prevents draft enqueue',async()=>{
  const f=await fileFixture(false);try{
    const s=scope(),api=scannerApi(s,f.store,f.queue);await api.start(randomUUID());const task=(await f.store.claim())!;
    const {p,charges}=providers([1,2]);
    await executeScan(task,p,{rate:async()=>{await api.cancel(task.id);await f.store.save(task);return{score:90,reason:'Strong job.'};}},f.store,f.queue);
    assert.equal(task.stopReason,'canceled');assert.equal(task.selected.length,0);assert.equal(await f.queue.claim(),undefined);assert.deepEqual(charges,['job_scan']);
    assert.equal((await f.store.get(s,task.id))!.cancelRequested,true);
  }finally{await f.close();}
});

test('canceling during an active build preserves its completed draft and never scans a next row',async()=>{
  const f=await fileFixture(false);try{
    const s=scope(),api=scannerApi(s,f.store,f.queue);await api.start(randomUUID());const task=(await f.store.claim())!;
    const list=f.queue.listById.bind(f.queue);
    f.queue.listById=async(scope,ids)=>{
      const build=(await f.queue.claim())!;assert(build,'exactly one draft is enqueued');
      await api.cancel(task.id);
      assert.equal(await f.queue.cancelQueued(scope,build.id),false,'a running write must not be falsely canceled');
      build.state='succeeded';build.result={state:'exists',label:'Draft',postStatus:'draft'};await f.queue.save(build);
      return list(scope,ids);
    };
    const {p}=providers([1,2]);let rated=0;
    await executeScan(task,p,{rate:async()=>{rated++;return{score:85,reason:'Strong job.'};}},f.store,f.queue);
    assert.equal(rated,1);assert.equal(task.stopReason,'canceled');assert.equal(task.selected[0]!.build!.state,'succeeded');
  }finally{await f.close();}
});

test('queued build cancellation prevents the worker from claiming that draft',async()=>{
  const f=await fileFixture(false);try{
    const s=scope(),api=scannerApi(s,f.store,f.queue);await api.start(randomUUID());const task=(await f.store.claim())!;
    const list=f.queue.listById.bind(f.queue);
    f.queue.listById=async(scope,ids)=>{await api.cancel(task.id);return list(scope,ids);};
    await executeScan(task,providers([1,2]).p,{rate:async()=>({score:85,reason:'Strong job.'})},f.store,f.queue);
    assert.equal(task.stopReason,'canceled');assert.equal(task.selected[0]!.build!.state,'failed');assert.equal(await f.queue.claim(),undefined);
  }finally{await f.close();}
});

test('sequential scan uses real draft builds and spends the scan plus each build in order',async()=>{
  const f=await fileFixture(false);try{
    const s=scope();await f.store.enqueue(s,randomUUID());const task=(await f.store.claim())!;
    const {p,charges}=providers([1,2]);const pushed:number[]=[];
    p.serviceTitan.getJobImage=async(_job,id)=>({id,fileName:'photo.jpg',contentType:'image/jpeg',bytes:new Uint8Array([1,2,3])});
    p.copyGenerator.generate=async()=>({title:'Valve Service in Rome, GA',bodyHtml:'<p>A technician inspected a leaking valve in Rome, Georgia, and documented the replacement work.</p>',seoTitle:'Valve Service in Rome',seoDescription:'A documented valve service visit in Rome, Georgia, addressed a leaking valve with a replacement recorded in the technician notes.'});
    p.wordpress.pushJob=async(job,_images,status)=>{assert.equal(status,'draft');pushed.push(job.id);return{state:'exists',label:'Draft',postStatus:'draft',postId:job.id};};
    const {BuildQueueWorker}=await import('./build-queue.js');const {buildAndDeploy}=await import('./build-deploy.js');
    const worker=new BuildQueueWorker(f.queue,build=>buildAndDeploy(build.jobId,p,build.id));
    const list=f.queue.listById.bind(f.queue);
    f.queue.listById=async(scope,ids)=>{await worker.runOnce();return list(scope,ids);};
    let evaluated=0;
    await executeScan(task,p,{rate:async()=>{assert.equal(pushed.length,evaluated);evaluated++;return{score:80,reason:'Useful project details.'};}},f.store,f.queue);
    assert.deepEqual(pushed,[1,2]);assert.deepEqual(charges,['job_scan','build','build']);
    assert.equal(task.selected.every(item=>item.build?.result?.postStatus==='draft'),true);
  }finally{await f.close();}
});

test('scan cancellation cannot cancel a queued build created outside that scan',async()=>{
  const f=await fileFixture(false);try{
    const s=scope();const manual=await f.queue.enqueue(s,1),scanId=randomUUID();
    const reused=await f.queue.enqueue(s,1,scanId);assert.equal(reused.id,manual.id);
    assert.equal(await f.queue.cancelQueued(s,reused.id,scanId),false);
    assert.equal((await f.queue.claim())!.id,manual.id);
    const owned=await f.queue.enqueue(s,2,scanId);
    assert.equal(await f.queue.cancelQueued(s,owned.id,randomUUID()),false);
    assert.equal(await f.queue.cancelQueued(s,owned.id,scanId),true);
  }finally{await f.close();}
});
