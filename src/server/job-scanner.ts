import type { BuildProviders } from './build-deploy.js';
import type { BuildQueueStore, BuildScope } from './build-queue.js';
import type { JobScorer } from './job-scorer.js';
import type { ScannerTask } from '../shared/job-scanner.js';
import { SCANNER_MAX_JOBS, SCANNER_MAX_RATINGS, SCANNER_MIN_SCORE } from '../shared/job-scanner.js';
import { TokenOperationSafeFailure } from './token-operation.js';
import { safeWorkText } from './work-content.js';
export interface StoredScannerTask extends ScannerTask, BuildScope { updatedAt: number; }
export interface ScannerStore {
  enqueue(scope: BuildScope, id: string): Promise<StoredScannerTask>;
  latest(scope: BuildScope): Promise<StoredScannerTask | undefined>;
  claim(): Promise<StoredScannerTask | undefined>;
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
  if (task.state === 'drafting' && task.selected.every(item => item.build && ['succeeded','failed'].includes(item.build.state))) {
    task.state = 'succeeded'; await store.save(task);
  }
  return task;
}
export async function executeScan(task: StoredScannerTask, providers: BuildProviders, scorer: JobScorer, store: ScannerStore, queue: BuildQueueStore) {
  if (!providers.serviceTitan.getScannerJobs) throw new Error('Job scanning is unavailable.');
  if ((await providers.wordpress.getPluginStatus()).state !== 'current') throw new Error('Verify the WordPress plugin before scanning.');
  const spend = providers.spendJobToken || (async <T>(_action: string, operation: () => Promise<T>) => operation());
  const found = await spend('job_scan', async () => {
    try {
      const started = Date.now(); const seen = new Set<number>();
      outer: for (let page = 1; page <= 20 && task.scanned < SCANNER_MAX_JOBS; page++) {
        if (Date.now() - started > 10 * 60000) { task.stopReason = 'limits'; break; }
        const jobs = await providers.serviceTitan.getScannerJobs!(page);
        if (!jobs.data.length) { task.stopReason = 'exhausted'; break; }
        const statuses = await providers.wordpress.getStatuses(jobs.data.map(job => job.id));
        for (const job of jobs.data) {
          if (seen.has(job.id)) continue;
          seen.add(job.id); task.scanned++;
          if (task.scanned > SCANNER_MAX_JOBS || task.rated >= SCANNER_MAX_RATINGS || Date.now() - started > 10 * 60000) { task.stopReason = 'limits'; break outer; }
          // An unknown/missing WordPress response is never interpreted as permission to duplicate a post.
          if (statuses[job.id]?.state !== 'not_found') continue;
          let details;
          try { details = await providers.serviceTitan.getJobDetails(job.id); }
          catch { continue; }
          const notes = details.history.filter(item => item.promptEligible).map(item => item.content);
          const content = [details.summary.workSummary, details.summary.summaryText, ...(details.summary.invoiceSummaries || []), ...(details.summary.invoiceWorkItems || []), ...(details.summary.formFindings || []).map(item => item.answer), ...notes].filter(Boolean).join(' ');
          if (content.length < 120 || !details.attachments.length) continue;
          const rating = await scorer.rate({ ...details.summary, technicianNotes: notes });
          task.rated++;
          if (rating.score >= SCANNER_MIN_SCORE) task.candidates.push({ jobId: job.id, title: safeWorkText(details.summary.descriptionPreview || details.summary.workSummary || details.summary.summaryText || details.summary.jobName,160), ...rating });
          await store.save(task);
          if (task.candidates.length >= 10) { task.stopReason = 'ten_candidates'; break outer; }
        }
        await store.save(task);
        if (!jobs.hasMore) { task.stopReason = 'exhausted'; break; }
      }
      task.stopReason ||= 'limits';
      return { scanned: task.scanned, rated: task.rated, candidates: task.candidates, stopReason: task.stopReason };
    } catch (error) { throw new TokenOperationSafeFailure(error); }
  }, undefined, `${task.id}-scan`, JSON.stringify({ scanner: task.id }));
  Object.assign(task, found);
  const best = [...task.candidates].sort((a,b) => b.score - a.score).slice(0,5);
  for (const candidate of best) {
    await store.touch(task);
    const build = await queue.enqueue(task, candidate.jobId);
    task.selected.push({ ...candidate, buildTaskId: build.id, build });
    await store.save(task);
  }
  task.state = task.selected.length ? 'drafting' : 'succeeded';
  await store.save(task);
}

export class ScannerWorker {
  private stopped = false; private timer?: NodeJS.Timeout; private running?: Promise<void>;
  constructor(private readonly store: ScannerStore, private readonly execute: (task: StoredScannerTask) => Promise<void>) {}
  start() {
    const tick = () => {
      if (this.stopped) return;
      this.running = this.runOnce().catch(() => console.error('Job Scanner could not access its queue.')).finally(() => {
        if (!this.stopped) { this.timer = setTimeout(tick,30000); this.timer.unref(); }
      });
    }; tick();
  }
  async runOnce() {
    const task = await this.store.claim(); if (!task) return;
    const heartbeat = setInterval(() => { void this.store.touch(task).catch(() => console.error('Job Scanner heartbeat failed.')); },30000); heartbeat.unref();
    try { await this.execute(task); }
    catch (error) { task.state = 'failed'; task.error = error instanceof Error ? error.message : 'Scan failed. Check WordPress and token history before retrying.'; await this.store.save(task); }
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
    start: async (id: string) => {
      const task = await latest();
      if (task && (['queued','running','drafting'].includes(task.state) || task.selected.some(item => item.build && ['queued','running'].includes(item.build.state)))) return publicScan(task);
      return publicScan(await store.enqueue(scope,id));
    },
  };
}
