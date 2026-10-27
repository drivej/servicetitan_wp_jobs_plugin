import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { BuildScope } from './build-queue.js';
import type { Database } from './saas/database.js';
import type { ScannerStore, StoredScannerTask } from './job-scanner.js';
const interrupted = 'Scan interrupted. Check any queued drafts in WordPress and token history before starting another scan.';
const initialTask = (scope: BuildScope, id: string): StoredScannerTask => ({ ...scope, id, state: 'queued', createdAt: new Date().toISOString(), updatedAt: Date.now(), scanned: 0, rated: 0, candidates: [], selected: [] });
export class PostgresScannerStore implements ScannerStore {
  constructor(private readonly db: Database) {}
  enqueue(scope: BuildScope, id: string) {
    return this.db.transaction(undefined, async sql => {
      const previous = (await sql.query('SELECT payload FROM job_scanner_tasks WHERE id=$1 AND workspace_id=$2 AND website_id=$3', [id,scope.workspaceId,scope.websiteId])).rows[0];
      if (previous) return previous.payload as StoredScannerTask;
      const task = initialTask(scope,id);
      const row = (await sql.query(`INSERT INTO job_scanner_tasks(id,workspace_id,website_id,state,payload) VALUES($1,$2,$3,'queued',$4)
        ON CONFLICT(workspace_id,website_id) WHERE state IN ('queued','running','drafting') DO UPDATE SET website_id=EXCLUDED.website_id RETURNING payload`, [id,scope.workspaceId,scope.websiteId,JSON.stringify(task)])).rows[0]!;
      return row.payload as StoredScannerTask;
    });
  }
  latest(scope: BuildScope) {
    return this.db.transaction(undefined, async sql => (await sql.query('SELECT payload FROM job_scanner_tasks WHERE workspace_id=$1 AND website_id=$2 ORDER BY created_at DESC LIMIT 1', [scope.workspaceId,scope.websiteId])).rows[0]?.payload as StoredScannerTask | undefined);
  }
  get(scope: BuildScope,id:string) {
    return this.db.transaction(undefined,async sql=>(await sql.query('SELECT payload FROM job_scanner_tasks WHERE id=$1 AND workspace_id=$2 AND website_id=$3',[id,scope.workspaceId,scope.websiteId])).rows[0]?.payload as StoredScannerTask | undefined);
  }
  cancel(scope: BuildScope,id:string) {
    return this.db.transaction(undefined,async sql=>{
      const row=(await sql.query(`SELECT payload,state FROM job_scanner_tasks WHERE id=$1 AND workspace_id=$2 AND website_id=$3 FOR UPDATE`,[id,scope.workspaceId,scope.websiteId])).rows[0];
      if(!row)return undefined;
      const task=row.payload as StoredScannerTask;
      if(['queued','running','drafting'].includes(task.state) || task.state==='failed' && task.selected.some(item=>item.build && ['queued','running'].includes(item.build.state))){
        task.cancelRequested=true;
        if(task.state==='queued'){task.state='succeeded';task.stopReason='canceled';task.currentJob=null;}
        await sql.query('UPDATE job_scanner_tasks SET state=$2,payload=$3,updated_at=now() WHERE id=$1',[id,task.state,JSON.stringify(task)]);
      }
      return task;
    });
  }
  claim() {
    return this.db.transaction(undefined, async sql => {
      await sql.query(`UPDATE job_scanner_tasks SET state='failed',payload=payload || jsonb_build_object('state','failed','error',$1::text) WHERE state='running' AND updated_at<now()-interval '5 minutes'`,[interrupted]);
      const row = (await sql.query("SELECT payload FROM job_scanner_tasks WHERE state='queued' ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1")).rows[0];
      if (!row) return;
      const task = { ...(row.payload as StoredScannerTask), state: 'running' as const, updatedAt: Date.now() };
      await sql.query("UPDATE job_scanner_tasks SET state='running',payload=$2,updated_at=now() WHERE id=$1",[task.id,JSON.stringify(task)]);
      return task;
    });
  }
  async save(task: StoredScannerTask) {
    const changed = await this.db.transaction(undefined,sql => sql.query("UPDATE job_scanner_tasks SET state=$2,payload=$3::jsonb || jsonb_build_object('cancelRequested',COALESCE((payload->>'cancelRequested')::boolean,false) OR COALESCE(($3::jsonb->>'cancelRequested')::boolean,false)),updated_at=now() WHERE id=$1 AND workspace_id=$4 AND website_id=$5 AND (state IN ('running','drafting') OR state=$2 AND $2 IN ('succeeded','failed')) RETURNING id",[task.id,task.state,JSON.stringify(task),task.workspaceId,task.websiteId]));
    if (!changed.rows.length) throw new Error('This scan is no longer active.');
  }
  async touch(task: StoredScannerTask) {
    const changed = await this.db.transaction(undefined, sql => sql.query("UPDATE job_scanner_tasks SET updated_at=now() WHERE id=$1 AND state='running' RETURNING id",[task.id]));
    if (!changed.rows.length) throw new Error('This scan is no longer active.');
  }
}
export class FileScannerStore implements ScannerStore {
  private tail: Promise<unknown> = Promise.resolve();
  constructor(private readonly path: string) {}
  private access<T>(operation: (tasks: StoredScannerTask[]) => T): Promise<T> {
    const result = this.tail.then(async () => {
      let tasks: StoredScannerTask[] = [];
      try { tasks = JSON.parse(await readFile(this.path,'utf8')); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      const before = JSON.stringify(tasks); const value = operation(tasks); const after = JSON.stringify(tasks);
      if (after !== before) { await mkdir(dirname(this.path),{recursive:true}); await writeFile(`${this.path}.tmp`,after,{mode:0o600}); await rename(`${this.path}.tmp`,this.path); }
      return value;
    }); this.tail = result.catch(() => undefined); return result;
  }
  enqueue(scope: BuildScope,id: string) { return this.access(tasks => {
    const previous = tasks.find(task => task.workspaceId===scope.workspaceId && task.websiteId===scope.websiteId && (task.id===id || ['queued','running','drafting'].includes(task.state)));
    if (previous) return structuredClone(previous);
    const task = initialTask(scope,id); tasks.push(task); return structuredClone(task);
  }); }
  latest(scope: BuildScope) { return this.access(tasks => { const task = tasks.filter(task => task.workspaceId===scope.workspaceId && task.websiteId===scope.websiteId).at(-1); return task ? structuredClone(task) : undefined; }); }
  get(scope:BuildScope,id:string){return this.access(tasks=>{const task=tasks.find(item=>item.id===id && item.workspaceId===scope.workspaceId && item.websiteId===scope.websiteId);return task?structuredClone(task):undefined;});}
  cancel(scope:BuildScope,id:string){return this.access(tasks=>{
    const task=tasks.find(item=>item.id===id && item.workspaceId===scope.workspaceId && item.websiteId===scope.websiteId);if(!task)return undefined;
    if(['queued','running','drafting'].includes(task.state) || task.state==='failed' && task.selected.some(item=>item.build && ['queued','running'].includes(item.build.state))){
      task.cancelRequested=true;
      if(task.state==='queued'){task.state='succeeded';task.stopReason='canceled';task.currentJob=null;}
    }
    return structuredClone(task);
  });}
  claim() { return this.access(tasks => {
    for (const task of tasks) if (task.state==='running' && task.updatedAt<Date.now()-300000) { task.state='failed'; task.error=interrupted; }
    const task=tasks.find(task=>task.state==='queued'); if (!task) return;
    task.state='running'; task.updatedAt=Date.now(); return structuredClone(task);
  }); }
  async save(task: StoredScannerTask) { await this.access(tasks => { const index=tasks.findIndex(item=>item.id===task.id && item.workspaceId===task.workspaceId && item.websiteId===task.websiteId && (['running','drafting'].includes(item.state) || item.state===task.state && ['succeeded','failed'].includes(task.state))); if(index<0) throw new Error('This scan is no longer active.'); tasks[index]={...task,cancelRequested:Boolean(tasks[index]!.cancelRequested || task.cancelRequested),updatedAt:Date.now()}; }); }
  async touch(task: StoredScannerTask) { await this.access(tasks => { const stored=tasks.find(item=>item.id===task.id && item.state==='running'); if(!stored) throw new Error('This scan is no longer active.'); stored.updatedAt=Date.now(); }); }
}
