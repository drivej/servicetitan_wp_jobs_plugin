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

  async startImpersonation(actorId: string, actorWorkspaceId: string, memberId: string, workspaceId: string) {
    return this.db.transaction(actorId, async (sql) => {
      await this.requireAdmin(sql, actorId);
      const target = (await sql.query(`SELECT u.id FROM users u
        JOIN workspace_memberships m ON m.user_id=u.id AND m.workspace_id=$2
        JOIN workspaces w ON w.id=m.workspace_id JOIN users owner ON owner.id=w.owner_user_id
        WHERE u.id=$1 AND u.disabled_at IS NULL AND owner.disabled_at IS NULL`, [memberId, workspaceId])).rows[0];
      if (!target) throw new HttpError('Active member workspace not found.', 404);
      await sql.query("SELECT set_config('app.workspace_id',$1,true)", [actorWorkspaceId]);
      await sql.query(`INSERT INTO audit_logs(id,user_id,action,target_id,workspace_id)
        VALUES($1,$2,'platform.impersonation.started',$3,$4)`, [randomUUID(), actorId, memberId, actorWorkspaceId]);
    });
  }

  async auditImpersonationAction(actorId: string, actorWorkspaceId: string, memberId: string, action: 'platform.impersonation.action' | 'platform.impersonation.ended' | 'platform.impersonation.raw_service_titan_read' = 'platform.impersonation.action') {
    return this.db.transaction(actorId, async (sql) => {
      await this.requireAdmin(sql, actorId);
      await sql.query("SELECT set_config('app.workspace_id',$1,true)", [actorWorkspaceId]);
      await sql.query(`INSERT INTO audit_logs(id,user_id,action,target_id,workspace_id)
        VALUES($1,$2,$3,$4,$5)`, [randomUUID(), actorId, action, memberId, actorWorkspaceId]);
    });
  }

  async list(actorId: string, search: unknown = '', after: unknown = '') {
    if (typeof search !== 'string' || search.length > 200 || typeof after !== 'string') throw new HttpError('Invalid member search.');
    const cursor = after ? uuid(after) : null;
    return this.db.transaction(actorId, async (sql) => {
      await this.requireAdmin(sql, actorId);
      const rows = (await sql.query(`SELECT w.id,w.name FROM workspaces w
        WHERE ($1::uuid IS NULL OR w.id>$1)
          AND ($2='' OR EXISTS (
            SELECT 1 FROM workspace_memberships sm JOIN users su ON su.id=sm.user_id
            WHERE sm.workspace_id=w.id AND (strpos(lower(su.name),lower($2))>0 OR strpos(lower(su.email),lower($2))>0)
          ))
        ORDER BY w.id LIMIT 51`, [cursor, search])).rows;
      const page = rows.slice(0, 50);
      const workspaceIds = page.map((row) => String(row.id));
      const memberships = workspaceIds.length ? (await sql.query(`SELECT m.user_id,m.role,m.workspace_id,u.name,u.email,u.disabled_at,
          EXISTS(SELECT 1 FROM platform_administrators WHERE user_id=u.id) AS is_platform_admin
        FROM workspace_memberships m JOIN users u ON u.id=m.user_id
        WHERE m.workspace_id=ANY($1::uuid[])
        ORDER BY m.workspace_id,CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END,lower(u.email)`, [workspaceIds])).rows : [];
      const websites = workspaceIds.length ? (await sql.query(`SELECT workspace_id,name,url FROM websites
        WHERE workspace_id=ANY($1::uuid[]) ORDER BY name,url`, [workspaceIds])).rows : [];
      return { accounts: page.map((row) => ({
        workspaceId: String(row.id), name: String(row.name),
        websites: websites.filter((website) => website.workspace_id === row.id).map((website) => ({
          name: String(website.name), url: String(website.url),
        })),
        members: memberships.filter((member) => member.workspace_id === row.id).map((member) => ({
          id: String(member.user_id), name: String(member.name), email: String(member.email),
          disabled: member.disabled_at !== null, isPlatformAdmin: member.is_platform_admin === true,
          role: String(member.role),
        })),
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
