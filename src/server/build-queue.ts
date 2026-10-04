import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { BuildTask } from '../shared/build-queue.js';
import type { Database } from './saas/database.js';
import type { WordPressPostStatus } from './wordpress.js';

export interface BuildScope { userId: string; workspaceId: string; websiteId: string; }
export interface StoredBuildTask extends BuildTask, BuildScope { updatedAt: number; }
export interface BuildQueueStore {
  enqueue(scope: BuildScope, jobId: number): Promise<BuildTask>;
  list(scope: BuildScope, jobIds: number[]): Promise<BuildTask[]>;
  claim(): Promise<StoredBuildTask | undefined>;
  save(task: StoredBuildTask): Promise<void>;
}
const interruptedMessage = 'The server lost contact with this build. Check WordPress before retrying.';
const staleAfter = 5 * 60_000;
const publicTask = ({ id, jobId, state, error, result }: StoredBuildTask): BuildTask => ({ id, jobId, state, ...(error ? { error } : {}), ...(result ? { result } : {}) });

// Local mode has one server process. Atomic file replacement keeps accepted tasks
// across restarts; SaaS uses PostgreSQL for coordination across server instances.
export class FileBuildQueueStore implements BuildQueueStore {
  private tail: Promise<unknown> = Promise.resolve();
  constructor(private readonly path: string) {}
  private access<T>(operation: (tasks: StoredBuildTask[]) => T): Promise<T> {
    const work = this.tail.then(async () => {
      let tasks: StoredBuildTask[];
      try { tasks = JSON.parse(await readFile(this.path, 'utf8')); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; tasks = []; }
      const result = operation(tasks);
      await mkdir(dirname(this.path), { recursive: true });
      await writeFile(`${this.path}.tmp`, JSON.stringify(tasks), { mode: 0o600 });
      await rename(`${this.path}.tmp`, this.path);
      return result;
    });
    this.tail = work.catch(() => undefined);
    return work;
  }
  enqueue(scope: BuildScope, jobId: number) {
    return this.access((tasks) => {
      const existing = tasks.find((t) => t.websiteId === scope.websiteId && t.workspaceId === scope.workspaceId && t.jobId === jobId && ['queued', 'running'].includes(t.state));
      if (existing) return publicTask(existing);
      const task: StoredBuildTask = { ...scope, id: randomUUID(), jobId, state: 'queued', updatedAt: Date.now() };
      tasks.push(task);
      return publicTask(task);
    });
  }
  list(scope: BuildScope, jobIds: number[]) {
    return this.access((tasks) => Array.from(new Map(tasks.filter((t) => t.workspaceId === scope.workspaceId && t.websiteId === scope.websiteId && jobIds.includes(t.jobId)).map((t) => [t.jobId, publicTask(t)])).values()));
  }
  claim() {
    return this.access((tasks) => {
      for (const task of tasks) if (task.state === 'running' && task.updatedAt < Date.now() - staleAfter) {
        task.state = 'failed'; task.error = interruptedMessage;
      }
      const task = tasks.find((t) => t.state === 'queued');
      if (task) { task.state = 'running'; task.updatedAt = Date.now(); return { ...task }; }
    });
  }
  save(task: StoredBuildTask) {
    return this.access((tasks) => {
      const index = tasks.findIndex((t) => t.id === task.id && t.state === 'running');
      if (index >= 0) tasks[index] = { ...task, updatedAt: Date.now() };
    });
  }
}

export class PostgresBuildQueueStore implements BuildQueueStore {
  constructor(private readonly db: Database) {}
  enqueue(scope: BuildScope, jobId: number) {
    return this.db.transaction(undefined, async (sql) => {
      const task: StoredBuildTask = { ...scope, id: randomUUID(), jobId, state: 'queued', updatedAt: Date.now() };
      // A partial unique index serializes duplicate submissions across users and instances.
      const row = (await sql.query(`INSERT INTO build_deploy_tasks(id,workspace_id,website_id,job_id,state,payload)
        VALUES($1,$2,$3,$4,'queued',$5) ON CONFLICT(workspace_id,website_id,job_id) WHERE state IN ('queued','running')
        DO UPDATE SET job_id=EXCLUDED.job_id RETURNING payload`, [task.id, scope.workspaceId, scope.websiteId, jobId, JSON.stringify(task)])).rows[0]!;
      return publicTask(row.payload as StoredBuildTask);
    });
  }
  list(scope: BuildScope, jobIds: number[]) {
    return this.db.transaction(undefined, async (sql) => (await sql.query(`SELECT DISTINCT ON (job_id) payload FROM build_deploy_tasks
      WHERE workspace_id=$1 AND website_id=$2 AND job_id=ANY($3::bigint[]) ORDER BY job_id,created_at DESC`,
    [scope.workspaceId, scope.websiteId, jobIds])).rows.map((row) => publicTask(row.payload as StoredBuildTask)));
  }
  claim() {
    return this.db.transaction(undefined, async (sql) => {
      await sql.query(`UPDATE build_deploy_tasks SET state='failed',payload=payload || jsonb_build_object('state','failed','error',$1::text)
        WHERE state='running' AND updated_at < now() - interval '5 minutes'`, [interruptedMessage]);
      const row = (await sql.query(`SELECT id,payload FROM build_deploy_tasks WHERE state='queued' ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1`)).rows[0];
      if (!row) return undefined;
      const task = { ...(row.payload as StoredBuildTask), state: 'running' as const, updatedAt: Date.now() };
      await sql.query(`UPDATE build_deploy_tasks SET state='running',payload=$2,updated_at=now() WHERE id=$1`, [task.id, JSON.stringify(task)]);
      return task;
    });
  }
  async save(task: StoredBuildTask) {
    await this.db.transaction(undefined, (sql) => sql.query(`UPDATE build_deploy_tasks SET state=$2,payload=$3,updated_at=now() WHERE id=$1 AND state='running'`, [task.id, task.state, JSON.stringify(task)]));
  }
}

export class BuildQueueWorker {
  private stopped = false;
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;
  constructor(private readonly store: BuildQueueStore, private readonly execute: (task: StoredBuildTask) => Promise<WordPressPostStatus>) {}
  start() {
    const tick = () => {
      if (this.stopped) return;
      this.running = this.runOnce().catch(() => { console.error('Build queue worker could not access its queue.'); }).finally(() => {
        if (!this.stopped) { this.timer = setTimeout(tick, 1000); this.timer.unref(); }
      });
    };
    tick();
  }
  async stop() { this.stopped = true; clearTimeout(this.timer); await this.running; }
  async runOnce() {
    const task = await this.store.claim();
    if (!task) return;
    const heartbeat = setInterval(() => { void this.store.save({ ...task }).catch(() => console.error('Build queue heartbeat failed.')); }, 30_000);
    heartbeat.unref();
    try {
      const result = await this.execute(task);
      const { state, label, postId, postStatus, link } = result;
      task.result = { state, label, ...(postId ? { postId } : {}), ...(postStatus ? { postStatus } : {}), ...(link ? { link } : {}) };
      task.state = 'succeeded';
    }
    catch (error) { task.state = 'failed'; task.error = error instanceof Error ? error.message : 'Build and deploy failed.'; }
    finally { clearInterval(heartbeat); }
    await this.store.save(task);
  }
}
