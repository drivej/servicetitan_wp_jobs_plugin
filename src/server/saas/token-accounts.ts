import type { Database, Sql } from './database.js';
import { postTokenTransaction, transactionFrom } from './token-ledger.js';
import { HttpError, record, textField, uuid } from './validation.js';
export class TokenAccounts {
  constructor(private readonly db: Database) {}
  private async requirePlatformAdmin(sql: Sql, userId: string) {
    // Re-read privileges on every request; a stale session cannot retain access.
    const admin = (await sql.query(`SELECT u.id FROM platform_administrators a JOIN users u ON u.id=a.user_id
      WHERE a.user_id=$1 AND u.disabled_at IS NULL`, [userId])).rows[0];
    if (!admin) throw new HttpError('Platform administrator access required.', 403);
  }
  async list(userId: string, search: unknown = '', after: unknown = '') {
    if (typeof search !== 'string' || search.length > 200 || typeof after !== 'string') throw new HttpError('Invalid account search.');
    const cursor = after ? uuid(after) : null;
    return this.db.transaction(userId, async (sql) => {
      await this.requirePlatformAdmin(sql, userId);
      const rows = (await sql.query(`SELECT w.id,w.name,w.job_tokens,u.email AS owner_email,u.name AS owner_name
        FROM workspaces w JOIN users u ON u.id=w.owner_user_id
        WHERE ($1::uuid IS NULL OR w.id>$1) AND (strpos(lower(w.name),lower($2))>0 OR strpos(lower(u.email),lower($2))>0)
        ORDER BY w.id LIMIT 51`, [cursor, search])).rows;
      return { accounts: rows.slice(0, 50).map((row) => ({ id: String(row.id), name: String(row.name), balance: Number(row.job_tokens), ownerEmail: String(row.owner_email), ownerName: String(row.owner_name) })),
        nextCursor: rows.length > 50 ? String(rows[49]!.id) : null };
    });
  }
  async history(userId: string, workspaceId: string, before: unknown = '', platform = false) {
    if (typeof before !== 'string' || (before && (!/^[1-9]\d{0,17}$/.test(before)))) throw new HttpError('Invalid transaction cursor.');
    return this.db.transaction(userId, async (sql) => {
      if (platform) await this.requirePlatformAdmin(sql, userId);
      const workspace = (await sql.query('SELECT id,name,job_tokens FROM workspaces WHERE id=$1 FOR SHARE', [workspaceId])).rows[0];
      if (!platform) {
        const membership = (await sql.query(`SELECT m.role FROM workspace_memberships m JOIN users u ON u.id=m.user_id
          JOIN workspaces w ON w.id=m.workspace_id JOIN users owner ON owner.id=w.owner_user_id
          WHERE m.workspace_id=$1 AND m.user_id=$2 AND m.role IN ('owner','admin') AND u.disabled_at IS NULL AND owner.disabled_at IS NULL`, [workspaceId, userId])).rows[0];
        if (!membership) throw new HttpError('Workspace owner or admin access required.', 403);
      }
      if (!workspace) throw new HttpError('Workspace not found.', 404);
      const rows = (await sql.query(`SELECT t.*,u.name AS actor_name FROM token_transactions t LEFT JOIN users u ON u.id=t.actor_user_id
        WHERE workspace_id=$1 AND ($2::bigint IS NULL OR sequence<$2) ORDER BY sequence DESC LIMIT 51`, [workspaceId, before || null])).rows;
      const total = (await sql.query('SELECT COALESCE(sum(amount),0) AS balance FROM token_transactions WHERE workspace_id=$1', [workspaceId])).rows[0]!;
      const balance = Number(workspace.job_tokens), ledgerBalance = Number(total.balance);
      return { workspaceId, workspaceName: String(workspace.name), balance, ledgerBalance, reconciled: balance === ledgerBalance,
        transactions: rows.slice(0, 50).map((row) => ({ ...transactionFrom(row), actorName: row.actor_name ? String(row.actor_name) : null })),
        nextCursor: rows.length > 50 ? String(rows[49]!.sequence) : null };
    });
  }
  async adjust(userId: string, workspaceId: string, input: unknown) {
    const body = record(input, ['amount', 'reason', 'requestId']);
    const requestId = uuid(body.requestId);
    const reason = textField(body.reason, 'Adjustment reason', 500);
    if (typeof body.amount !== 'number' || !Number.isSafeInteger(body.amount) || body.amount === 0 || Math.abs(body.amount) > 2_147_483_647) throw new HttpError('Enter a nonzero integer token amount.');
    const amount = body.amount;
    return this.db.transaction(userId, async (sql) => {
      await this.requirePlatformAdmin(sql, userId);
      const transaction = await postTokenTransaction(sql, { workspaceId, kind: 'admin_adjustment', requestedAmount: amount,
        actorUserId: userId, reference: `admin:${requestId}`, reason });
      const balance = (await sql.query('SELECT job_tokens FROM workspaces WHERE id=$1', [workspaceId])).rows[0]!.job_tokens;
      return { transaction, balance: Number(balance) };
    });
  }
}
