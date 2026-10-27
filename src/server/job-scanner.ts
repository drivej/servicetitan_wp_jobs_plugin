import { rateScannerJob, scannerSkipReason } from './scanner-rating.js';
import type { BuildProviders } from './build-deploy.js';
import type { BuildQueueStore, BuildScope } from './build-queue.js';
import type { JobScorer } from './job-scorer.js';
import type { ScannerTask } from '../shared/job-scanner.js';
import { SCANNER_MAX_JOBS, SCANNER_MAX_RATINGS, SCANNER_MIN_SCORE, SCANNER_MAX_DRAFTS } from '../shared/job-scanner.js';
import { HttpError } from './saas/validation.js';
import { safeWorkText } from './work-content.js';
export interface StoredScannerTask extends ScannerTask, BuildScope { updatedAt: number; }
export interface ScannerStore {
  enqueue(scope: BuildScope, id: string): Promise<StoredScannerTask>;
  latest(scope: BuildScope): Promise<StoredScannerTask | undefined>;
  claim(): Promise<StoredScannerTask | undefined>;
  get(scope: BuildScope,id: string): Promise<StoredScannerTask | undefined>;
  cancel(scope: BuildScope,id: string): Promise<StoredScannerTask | undefined>;
  save(task: StoredScannerTask): Promise<void>;
  touch(task: StoredScannerTask): Promise<void>;
}
export const publicScan = (task: StoredScannerTask): ScannerTask => {
  const { userId: _user, workspaceId: _workspace, websiteId: _website, updatedAt: _updated, ...result } = task;
  return result;
};
export async function settleScan(task: StoredScannerTask, store: ScannerStore, queue: BuildQueueStore): Promise<StoredScannerTask> {
  if (!task.selected.length || !['drafting','failed'].includes(task.state)) return task;
  const builds = await queue.listById(task, task.selected.map(item => item.buildTaskId));
  task.selected = task.selected.map(item => { const build = builds.find(build => build.id === item.buildTaskId); return build ? { ...item, build } : item; });
  const settled=task.selected.every(item=>item.build && ['succeeded','failed'].includes(item.build.state));
  if(settled && (task.state==='drafting' || task.cancelRequested)){
    if(task.state==='drafting')task.state='succeeded';
    if(task.cancelRequested)task.stopReason='canceled';
    task.currentJob=null;await store.save(task);
  }
  return task;
}
export async function executeScan(task: StoredScannerTask, providers: BuildProviders, scorer: JobScorer, store: ScannerStore, queue: BuildQueueStore) {
  const canceled=async()=>Boolean((await store.get(task,task.id))?.cancelRequested);
  const finish=async(reason:NonNullable<ScannerTask['stopReason']>)=>{task.stopReason=await canceled()?'canceled':reason;task.currentJob=null;task.state='succeeded';await store.save(task);};
  if(await canceled()){await finish('canceled');return;}
  if (!providers.serviceTitan.getScannerJobs) throw new Error('Job scanning is unavailable.');
  if ((await providers.wordpress.getPluginStatus()).state !== 'current') throw new Error('Verify the WordPress plugin before scanning.');
  if(await canceled()){await finish('canceled');return;}
  const spend = providers.spendJobToken || (async <T>(_action: string, operation: () => Promise<T>) => operation());
  // Charge the scan once when work starts; each durable draft owns its own spend.
  await spend('job_scan',async()=>({scanId:task.id}),undefined,`${task.id}-scan`,JSON.stringify({scanner:task.id}));
  task.scanFeeCharged=true;await store.save(task);
  const started=Date.now(),seen=new Set<number>();
  outer: for(let page=1;page<=20;page++){
    if(await canceled()){task.stopReason='canceled';break;}
    if(task.scanned>=SCANNER_MAX_JOBS || task.rated>=SCANNER_MAX_RATINGS || Date.now()-started>10*60000){task.stopReason='limits';break;}
    task.currentJob={title:'Finding your next promising job',stage:'searching'};await store.save(task);
    const jobs=await providers.serviceTitan.getScannerJobs(page);
    if(!jobs.data.length){task.stopReason='exhausted';break;}
    const statuses=await providers.wordpress.getStatuses(jobs.data.map(job=>job.id));
    for(const job of jobs.data){
      if(await canceled()){task.stopReason='canceled';break outer;}
      if(task.scanned>=SCANNER_MAX_JOBS || task.rated>=SCANNER_MAX_RATINGS || Date.now()-started>10*60000){task.stopReason='limits';break outer;}
      if(seen.has(job.id))continue;
      seen.add(job.id);task.scanned++;
      if(statuses[job.id]?.state!=='not_found')continue;
      task.currentJob={jobId:job.id,title:safeWorkText(job.descriptionPreview || job.jobName,160),stage:'checking'};await store.save(task);
      let details;
      try{details=await providers.serviceTitan.getJobDetails(job.id);}catch{continue;}
      if(scannerSkipReason(details))continue;
      if(await canceled()){task.stopReason='canceled';break outer;}
      task.currentJob={...task.currentJob,stage:'rating'};await store.save(task);
      const rating=await rateScannerJob(details,scorer);task.rated++;
      if(await canceled()){task.stopReason='canceled';break outer;}
      if(rating.score<SCANNER_MIN_SCORE){await store.save(task);continue;}
      const candidate={jobId:job.id,title:safeWorkText(details.summary.descriptionPreview || details.summary.workSummary || details.summary.summaryText || details.summary.jobName,160),...rating};
      task.candidates.push(candidate);
      task.currentJob={jobId:job.id,title:candidate.title,stage:'drafting',score:rating.score};await store.save(task);
      if(await canceled()){task.stopReason='canceled';break outer;}
      const build=await queue.enqueue(task,job.id,task.id);
      const selected={...candidate,buildTaskId:build.id,build};task.selected.push(selected);await store.save(task);
      // Keep the existing durable worker. Wait for this exact build before
      // evaluating another job; never have this scanner queue a batch ahead.
      while(true){
        if(await canceled())await queue.cancelQueued(task,build.id,task.id);
        const current=(await queue.listById(task,[build.id]))[0];
        if(!current)throw new Error('Draft task is unavailable. Check WordPress before retrying.');
        if(JSON.stringify(current)!==JSON.stringify(selected.build)){selected.build=current;await store.save(task);}
        if(['succeeded','failed'].includes(current.state))break;
        await new Promise(resolve=>setTimeout(resolve,1000));
      }
      if(await canceled()){task.stopReason='canceled';break outer;}
      const draftsReady=task.selected.filter(item=>item.build?.state==='succeeded' && item.build.result?.state==='exists').length;
      if(draftsReady>=SCANNER_MAX_DRAFTS){task.stopReason='five_drafts';break outer;}
    }
    await store.save(task);
    if(!jobs.hasMore){task.stopReason='exhausted';break;}
  }
  await finish(task.stopReason || 'limits');
}

export class ScannerWorker {
  private stopped = false; private timer?: NodeJS.Timeout; private running?: Promise<void>;
  constructor(private readonly store: ScannerStore, private readonly execute: (task: StoredScannerTask) => Promise<void>) {}
  start() {
    const tick = () => {
      if (this.stopped) return;
      this.running = this.runOnce().catch(() => console.error('Job Scanner could not access its queue.')).finally(() => {
        if (!this.stopped) { this.timer = setTimeout(tick,1000); this.timer.unref(); }
      });
    }; tick();
  }
  async runOnce() {
    const task = await this.store.claim(); if (!task) return;
    const heartbeat = setInterval(() => { void this.store.touch(task).catch(() => console.error('Job Scanner heartbeat failed.')); },30000); heartbeat.unref();
    try { await this.execute(task); }
    catch (error) { task.state = 'failed'; task.currentJob=null; task.error = error instanceof Error ? error.message : 'Scan failed. Check WordPress and token history before retrying.'; await this.store.save(task); }
    finally { clearInterval(heartbeat); }
  }
  async stop() { this.stopped = true; clearTimeout(this.timer); await this.running; }
}

export function scannerApi(scope: BuildScope, store: ScannerStore, queue: BuildQueueStore) {
  const latest = async () => {
    const task = await store.latest(scope);
    return task ? settleScan(task,store,queue) : undefined;
  };
  return {
    latest: async () => { const task = await latest(); return task ? publicScan(task) : null; },
    cancel: async(id:string)=>{
      const task=await store.cancel(scope,id);
      if(!task)throw new HttpError('Scan not found.',404);
      if(task.cancelRequested)for(const item of task.selected)await queue.cancelQueued(scope,item.buildTaskId,task.id);
      return publicScan(await settleScan(task,store,queue));
    },
    start: async (id: string) => {
      const task = await latest();
      if (task && (['queued','running','drafting'].includes(task.state) || task.selected.some(item => item.build && ['queued','running'].includes(item.build.state)))) return publicScan(task);
      return publicScan(await store.enqueue(scope,id));
    },
  };
}
