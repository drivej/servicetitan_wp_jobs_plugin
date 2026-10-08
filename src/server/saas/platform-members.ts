import { randomUUID } from 'node:crypto';
import type { Database, Sql } from './database.js';
import { HttpError, uuid } from './validation.js';

export class PlatformMembers {
  constructor(private readonly db: Database) {}

  private async requireAdmin(sql: Sql, actorId: string) {
    const admin = (await sql.query(`SELECT 1 FROM platform_administrators a JOIN users u ON u.id=a.user_id
      WHERE a.user_id=$1 AND u.disabled_at IS NULL`, [actorId])).rows[0];
    if (!admin) throw new HttpError('Platform administrator access required.', 403);
  }

  async requirePlatformAdmin(actorId: string): Promise<void> {
    await this.db.transaction(actorId, async (sql) => this.requireAdmin(sql, actorId));
  }

  async jobPreviewOptions(actorId: string, actorWorkspaceId: string, memberId: string) {
    return this.db.transaction(actorId, async (sql) => {
      await this.requireAdmin(sql, actorId);
      const target = (await sql.query('SELECT id,name,email,disabled_at FROM users WHERE id=$1', [memberId])).rows[0];
      if (!target || target.disabled_at !== null) throw new HttpError('Active member not found.', 404);
      const workspaces = (await sql.query(`SELECT w.id AS "workspaceId",w.name AS "workspaceName",m.role
        FROM workspace_memberships m JOIN workspaces w ON w.id=m.workspace_id
        WHERE m.user_id=$1 ORDER BY w.name,w.id`, [memberId])).rows;
      const options = [] as Array<{ workspaceId: string; workspaceName: string; role: string; websites: Array<{ id: string; name: string }> }>;
      for (const workspace of workspaces) {
        await sql.query("SELECT set_config('app.user_id',$1,true),set_config('app.workspace_id',$2,true)", [memberId, workspace.workspaceId]);
        const websites = (await sql.query(`SELECT id,name FROM websites WHERE workspace_id=$1 AND connection_id IS NOT NULL ORDER BY created_at,id`, [workspace.workspaceId])).rows;
        options.push({ workspaceId: String(workspace.workspaceId), workspaceName: String(workspace.workspaceName), role: String(workspace.role), websites: websites.map((site) => ({ id: String(site.id), name: String(site.name) })) });
      }
      await sql.query("SELECT set_config('app.user_id',$1,true),set_config('app.workspace_id',$2,true)", [actorId, actorWorkspaceId]);
      await sql.query(`INSERT INTO audit_logs(id,user_id,action,target_id,workspace_id)
        VALUES($1,$2,'platform.member.job_preview_opened',$3,$4)`, [randomUUID(), actorId, memberId, actorWorkspaceId]);
      return { member: { id: String(target.id), name: String(target.name), email: String(target.email) }, workspaces: options };
    });
  }

  async auditJobPreview(actorId: string, actorWorkspaceId: string, websiteId: string, jobId?: number) {
    return this.db.transaction(actorId, async (sql) => {
      await this.requireAdmin(sql, actorId);
      await sql.query("SELECT set_config('app.workspace_id',$1,true)", [actorWorkspaceId]);
      await sql.query(`INSERT INTO audit_logs(id,user_id,action,target_id,job_id,workspace_id)
        VALUES($1,$2,'platform.member.job_preview_read',$3,$4,$5)`, [randomUUID(), actorId, websiteId, jobId ?? null, actorWorkspaceId]);
    });
  }

  async list(actorId: string, search: unknown = '', after: unknown = '') {
    if (typeof search !== 'string' || search.length > 200 || typeof after !== 'string') throw new HttpError('Invalid member search.');
    const cursor = after ? uuid(after) : null;
    return this.db.transaction(actorId, async (sql) => {
      await this.requireAdmin(sql, actorId);
      const rows = (await sql.query(`SELECT id,name,email,disabled_at,
        EXISTS(SELECT 1 FROM platform_administrators WHERE user_id=users.id) AS is_platform_admin FROM users
        WHERE ($1::uuid IS NULL OR id>$1) AND (strpos(lower(name),lower($2))>0 OR strpos(lower(email),lower($2))>0)
        ORDER BY id LIMIT 51`, [cursor, search])).rows;
      const page = rows.slice(0, 50);
      const ids = page.map((row) => String(row.id));
      const memberships = ids.length ? (await sql.query(`SELECT m.user_id,m.role,w.id AS workspace_id,w.name AS workspace_name
        FROM workspace_memberships m JOIN workspaces w ON w.id=m.workspace_id
        WHERE m.user_id=ANY($1::uuid[]) ORDER BY w.name,w.id`, [ids])).rows : [];
      return { members: page.map((row) => ({
        id: String(row.id), name: String(row.name), email: String(row.email), disabled: row.disabled_at !== null,
        isPlatformAdmin: row.is_platform_admin === true,
        roles: memberships.filter((membership) => membership.user_id === row.id).map((membership) => ({
          workspaceId: String(membership.workspace_id), workspaceName: String(membership.workspace_name), role: String(membership.role)
        }))
      })), nextCursor: rows.length > 50 ? String(page[49]!.id) : null };
    });
  }

  async disable(actorId: string, memberId: string): Promise<void> {
    if (actorId === memberId) throw new HttpError('You cannot disable your own account.', 409);
    return this.db.transaction(actorId, async (sql) => {
      await this.requireAdmin(sql, actorId);
      const target = (await sql.query('SELECT disabled_at FROM users WHERE id=$1 FOR UPDATE', [memberId])).rows[0];
      if (!target) throw new HttpError('Member not found.', 404);
      if (target.disabled_at !== null) return;
      const platformAdmin = (await sql.query('SELECT 1 FROM platform_administrators WHERE user_id=$1', [memberId])).rows[0];
      if (platformAdmin) throw new HttpError('Platform administrators cannot be disabled here.', 409);
      await sql.query('UPDATE users SET disabled_at=now(),updated_at=now() WHERE id=$1', [memberId]);
      await sql.query('DELETE FROM sessions WHERE user_id=$1', [memberId]);
      await sql.query("SELECT set_config('app.workspace_id',$1,true)", [actorId]);
      await sql.query(`INSERT INTO audit_logs(id,user_id,action,target_id,workspace_id)
        VALUES($1,$2,'platform.member.disable',$3,$2)`, [randomUUID(), actorId, memberId]);
    });
  }
}
