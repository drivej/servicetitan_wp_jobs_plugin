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

  async deleteAccount(actorId: string, workspaceId: string, confirmation: unknown,
    cleanupBilling?: (account: { customerId: string | null; checkoutId: string | null }) => Promise<void>) {
    if (confirmation !== 'DELETE') throw new HttpError('Type DELETE to confirm permanent account deletion.');
    return this.db.transaction(actorId, async sql => {
      await this.requireAdmin(sql, actorId);
      const workspace=(await sql.query('SELECT id,owner_user_id FROM workspaces WHERE id=$1 FOR UPDATE',[workspaceId])).rows[0];
      if (!workspace) throw new HttpError('Account not found.',404);
      // Lock users before deciding who has no other account. Concurrent logins or
      // invitations cannot attach a new membership to a user being erased.
      const members=(await sql.query(`SELECT id FROM users WHERE id IN (
        SELECT user_id FROM workspace_memberships WHERE workspace_id=$1 UNION SELECT owner_user_id FROM workspaces WHERE id=$1
      ) ORDER BY id FOR UPDATE`,[workspaceId])).rows.map(row=>String(row.id));
      const orphans=(await sql.query(`SELECT id,email FROM users u WHERE id=ANY($1::uuid[])
        AND NOT EXISTS(SELECT 1 FROM workspace_memberships m WHERE m.user_id=u.id AND m.workspace_id<>$2)
        AND NOT EXISTS(SELECT 1 FROM workspaces w WHERE w.owner_user_id=u.id AND w.id<>$2)`,[members,workspaceId])).rows;
      if (orphans.some(row=>row.id===actorId)) throw new HttpError('You cannot delete the last account you belong to. Another superadmin must perform this deletion.',409);
      const active=(await sql.query(`SELECT
        EXISTS(SELECT 1 FROM build_deploy_tasks WHERE workspace_id=$1 AND state='running') OR
        EXISTS(SELECT 1 FROM job_scanner_tasks WHERE workspace_id=$1 AND state IN ('running','drafting')) OR
        EXISTS(SELECT 1 FROM token_spend_operations WHERE workspace_id=$1 AND state='reserved') AS active`,[workspaceId])).rows[0];
      if (active?.active) throw new HttpError('This account has work in progress. Wait for it to finish or reconcile interrupted operations, then retry deletion.',409);
      const billing=(await sql.query('SELECT customer_id,checkout_id FROM workspace_billing WHERE workspace_id=$1',[workspaceId])).rows[0];
      if (billing?.customer_id || billing?.checkout_id) {
        if (!cleanupBilling) throw new HttpError('Billing must be configured to remove this account’s Stripe customer and subscriptions.',503);
        await cleanupBilling({ customerId: billing.customer_id ? String(billing.customer_id) : null, checkoutId: billing.checkout_id ? String(billing.checkout_id) : null });
      }
      // Erase incoming requests targeting installations this account owns, as well
      // as requests made by the account (the latter also cascade below).
      await sql.query(`DELETE FROM website_ownership_requests r WHERE requester_workspace_id=$1 OR EXISTS(
        SELECT 1 FROM websites w WHERE w.workspace_id=$1 AND w.installation_id IS NOT NULL
          AND (w.installation_id=r.installation_id OR w.canonical_url=r.canonical_url))`,[workspaceId]);
      await sql.query('DELETE FROM workspaces WHERE id=$1',[workspaceId]);
      if (orphans.length) {
        await sql.query('DELETE FROM workspace_invitations WHERE email=ANY($1::text[])',[orphans.map(row=>String(row.email).toLowerCase())]);
        await sql.query('DELETE FROM users WHERE id=ANY($1::uuid[])',[orphans.map(row=>String(row.id))]);
      }
      const auditWorkspace=(await sql.query('SELECT workspace_id FROM workspace_memberships WHERE user_id=$1 ORDER BY workspace_id LIMIT 1',[actorId])).rows[0];
      if (auditWorkspace) {
        await sql.query("SELECT set_config('app.workspace_id',$1,true)",[auditWorkspace.workspace_id]);
        await sql.query(`INSERT INTO audit_logs(id,user_id,action,target_id,workspace_id)
          VALUES($1,$2,'platform.account.deleted',$3,$4)`,[randomUUID(),actorId,workspaceId,auditWorkspace.workspace_id]);
      }
      return { deletedUsers: orphans.length, retainedUsers: members.length-orphans.length };
    });
  }

  private async auditWorkspace(sql: Sql, actorId: string): Promise<string> {
    const workspace=(await sql.query('SELECT workspace_id FROM workspace_memberships WHERE user_id=$1 ORDER BY workspace_id LIMIT 1',[actorId])).rows[0];
    if (!workspace) throw new HttpError('No administrative account is available.',409);
    await sql.query("SELECT set_config('app.workspace_id',$1,true)",[workspace.workspace_id]);
    return String(workspace.workspace_id);
  }

  async enable(actorId: string, memberId: string): Promise<void> {
    await this.db.transaction(actorId, async sql => {
      await this.requireAdmin(sql, actorId);
      const target = (await sql.query('SELECT disabled_at FROM users WHERE id=$1 FOR UPDATE', [memberId])).rows[0];
      if (!target) throw new HttpError('Member not found.',404);
      if (target.disabled_at === null) return;
      await sql.query('UPDATE users SET disabled_at=NULL,updated_at=now() WHERE id=$1', [memberId]);
      // Disabling revoked sessions; enabling never restores those old sessions.
      const auditWorkspace=await this.auditWorkspace(sql,actorId);
      await sql.query(`INSERT INTO audit_logs(id,user_id,action,target_id,workspace_id)
        VALUES($1,$2,'platform.member.enable',$3,$4)`, [randomUUID(),actorId,memberId,auditWorkspace]);
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
      const auditWorkspace=await this.auditWorkspace(sql,actorId);
      await sql.query(`INSERT INTO audit_logs(id,user_id,action,target_id,workspace_id)
        VALUES($1,$2,'platform.member.disable',$3,$4)`, [randomUUID(), actorId, memberId,auditWorkspace]);
    });
  }
}
