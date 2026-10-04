import { randomUUID } from 'node:crypto';
import type { Sql } from './database.js';
import { HttpError } from './validation.js';
export type TokenTransactionKind = 'stripe_credit' | 'spend' | 'test_credit' | 'admin_adjustment';
interface Entry {
  workspaceId: string;
  kind: TokenTransactionKind;
  requestedAmount: number;
  reference: string;
  reason: string;
  actorUserId?: string;
  websiteId?: string;
  jobId?: number;
  stripeInvoiceId?: string;
  maxTokens?: number;
}
export interface TokenTransaction {
  id: string; sequence: string; kind: string; amount: number; requestedAmount: number;
  discardedAmount: number; balanceBefore: number; balanceAfter: number;
  actorUserId: string | null; reference: string; reason: string;
  websiteId: string | null; jobId: number | null; stripeInvoiceId: string | null; createdAt: string;
}
export const transactionFrom = (r: Record<string, unknown>): TokenTransaction => ({
  id: String(r.id), sequence: String(r.sequence), kind: String(r.kind), amount: Number(r.amount),
  requestedAmount: Number(r.requested_amount), discardedAmount: Number(r.discarded_amount),
  balanceBefore: Number(r.balance_before), balanceAfter: Number(r.balance_after),
  actorUserId: r.actor_user_id ? String(r.actor_user_id) : null, reference: String(r.reference), reason: String(r.reason),
  websiteId: r.website_id ? String(r.website_id) : null, jobId: r.job_id == null ? null : Number(r.job_id),
  stripeInvoiceId: r.stripe_invoice_id ? String(r.stripe_invoice_id) : null, createdAt: new Date(String(r.created_at)).toISOString(),
});
// Caller owns a DB transaction. Ledger insert and cached balance update commit
// together; database triggers also enforce ordering and prohibit ledger edits.
export async function postTokenTransaction(sql: Sql, entry: Entry): Promise<TokenTransaction> {
  const workspace = (await sql.query('SELECT job_tokens FROM workspaces WHERE id=$1 FOR UPDATE', [entry.workspaceId])).rows[0];
  if (!workspace) throw new HttpError('Workspace not found.', 404);
  if (!Number.isSafeInteger(entry.requestedAmount) || entry.requestedAmount === 0 || Math.abs(entry.requestedAmount) > 2_147_483_647) throw new HttpError('Enter a nonzero integer token amount.');
  const existing = (await sql.query('SELECT * FROM token_transactions WHERE workspace_id=$1 AND reference=$2', [entry.workspaceId, entry.reference])).rows[0];
  if (existing) {
    if (existing.kind !== entry.kind || Number(existing.requested_amount) !== entry.requestedAmount || existing.reason !== entry.reason || (existing.actor_user_id || undefined) !== entry.actorUserId
      || (existing.website_id || undefined) !== entry.websiteId || (existing.job_id == null ? undefined : Number(existing.job_id)) !== entry.jobId || (existing.stripe_invoice_id || undefined) !== entry.stripeInvoiceId) {
      throw new HttpError('This transaction reference was already used for different details.', 409);
    }
    return transactionFrom(existing);
  }
  const before = Number(workspace.job_tokens);
  const after = entry.maxTokens === undefined ? before + entry.requestedAmount : Math.min(before + entry.requestedAmount, entry.maxTokens);
  if (!Number.isSafeInteger(after) || after < 0 || after > 2_147_483_647) throw new HttpError('This transaction would put the balance outside its allowed range.', 409);
  const amount = after - before;
  const sequence = (await sql.query('SELECT COALESCE(max(sequence),0)+1 AS next FROM token_transactions WHERE workspace_id=$1', [entry.workspaceId])).rows[0]!.next;
  const row = (await sql.query(`INSERT INTO token_transactions(id,workspace_id,sequence,kind,amount,requested_amount,discarded_amount,balance_before,balance_after,actor_user_id,reference,reason,website_id,job_id,stripe_invoice_id)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
    [randomUUID(), entry.workspaceId, sequence, entry.kind, amount, entry.requestedAmount, entry.requestedAmount - amount, before, after, entry.actorUserId || null, entry.reference, entry.reason, entry.websiteId || null, entry.jobId ?? null, entry.stripeInvoiceId || null])).rows[0]!;
  return transactionFrom(row);
}
