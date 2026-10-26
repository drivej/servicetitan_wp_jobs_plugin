-- ACCOUNT DELETION RECOVERY: run this entire file in one SQL-editor execution.
-- Supports missing, partially applied, and fully applied migration-015 objects.
-- No ledger rows, balances, users, accounts, or queue payloads are deleted here.
-- Original migration-015 checksum: 3a77117d2070c92e5a387f0e381f02de09314f5cbd98d7ea83bc41701bd2ec84
BEGIN;
SELECT pg_advisory_xact_lock(817250031);
-- Only the table owner is exempt while validating existing FK references.
-- Ordinary roles retain tenant RLS. FORCE is restored before COMMIT.
ALTER TABLE websites ENABLE ROW LEVEL SECURITY;
ALTER TABLE websites NO FORCE ROW LEVEL SECURITY;

-- Earlier migrations can leave deferred balance checks pending in this batch.
SET CONSTRAINTS ALL IMMEDIATE;
-- Account erasure cascades its own records; surviving accounts retain their data.
-- Historical actor references are anonymized only when the user is actually erased.
ALTER TABLE audit_logs ALTER COLUMN user_id DROP NOT NULL;
ALTER TABLE workspace_invitations ALTER COLUMN invited_by DROP NOT NULL;
ALTER TABLE token_spend_operations ALTER COLUMN actor_user_id DROP NOT NULL;
ALTER TABLE token_transactions ADD COLUMN IF NOT EXISTS actor_deleted boolean NOT NULL DEFAULT false;
DO $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_attribute a JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
    WHERE a.attrelid='token_transactions'::regclass AND a.attname='actor_deleted' AND NOT a.attisdropped
      AND a.atttypid='boolean'::regtype AND a.attnotnull AND pg_get_expr(d.adbin,d.adrelid)='false')
  THEN RAISE EXCEPTION 'Existing token_transactions.actor_deleted does not match boolean NOT NULL DEFAULT false. Recovery stopped without changing ledger data.'; END IF;
END $$;
-- Locate the historical admin-adjustment actor check without relying on generated names.
DO $$
DECLARE c record;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint WHERE conrelid='token_transactions'::regclass AND contype='c'
    AND pg_get_constraintdef(oid) LIKE '%admin_adjustment%' AND pg_get_constraintdef(oid) LIKE '%actor_user_id%'
  LOOP EXECUTE format('ALTER TABLE token_transactions DROP CONSTRAINT %I',c.conname); END LOOP;
END $$;
ALTER TABLE token_transactions DROP CONSTRAINT IF EXISTS token_actor_required;
ALTER TABLE token_transactions ADD CONSTRAINT token_actor_required CHECK (
 (kind <> 'admin_adjustment' OR actor_user_id IS NOT NULL OR actor_deleted) AND (NOT actor_deleted OR actor_user_id IS NULL));

-- Existing generated columns are checked before being reused; no column or payload is dropped.
ALTER TABLE build_deploy_tasks ADD COLUMN IF NOT EXISTS actor_user_id uuid GENERATED ALWAYS AS ((payload->>'userId')::uuid) STORED;
ALTER TABLE job_scanner_tasks ADD COLUMN IF NOT EXISTS actor_user_id uuid GENERATED ALWAYS AS ((payload->>'userId')::uuid) STORED;
DO $$
DECLARE target text;
BEGIN
  FOREACH target IN ARRAY ARRAY['build_deploy_tasks','job_scanner_tasks'] LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_attribute a JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
      WHERE a.attrelid=to_regclass(target) AND a.attname='actor_user_id' AND NOT a.attisdropped
        AND a.atttypid='uuid'::regtype AND a.attgenerated='s'
        AND regexp_replace(pg_get_expr(d.adbin,d.adrelid),'[[:space:]()]','','g')='payload->>''userId''::text::uuid')
    THEN RAISE EXCEPTION 'Existing %.actor_user_id is not the expected stored generated user UUID. Recovery stopped.',target; END IF;
  END LOOP;
END $$;

DO $$
DECLARE item record; fk record;
BEGIN
  FOR item IN SELECT * FROM (VALUES
    ('workspace_memberships','workspace_id','workspaces','CASCADE'),
    ('workspace_invitations','workspace_id','workspaces','CASCADE'),
    ('sessions','workspace_id','workspaces','SET NULL'),
    ('servicetitan_connections','workspace_id','workspaces','CASCADE'),
    ('websites','workspace_id','workspaces','CASCADE'),
    ('audit_logs','workspace_id','workspaces','CASCADE'),
    ('workspace_billing','workspace_id','workspaces','CASCADE'),
    ('stripe_token_grants','workspace_id','workspaces','CASCADE'),
    ('token_transactions','workspace_id','workspaces','CASCADE'),
    ('token_spend_operations','workspace_id','workspaces','CASCADE'),
    ('website_ownership_requests','requester_workspace_id','workspaces','CASCADE'),
    ('sessions','user_id','users','CASCADE'),
    ('workspace_memberships','user_id','users','CASCADE'),
    ('workspace_invitations','invited_by','users','SET NULL'),
    ('audit_logs','user_id','users','SET NULL'),
    ('platform_administrators','user_id','users','CASCADE'),
    ('token_transactions','actor_user_id','users','SET NULL'),
    ('token_spend_operations','actor_user_id','users','SET NULL'),
    ('token_spend_operations','resolved_by','users','SET NULL'),
    ('website_ownership_requests','requester_id','users','CASCADE'),
    ('token_transactions','website_id','websites','SET NULL'),
    ('token_spend_operations','website_id','websites','CASCADE'),
    ('build_deploy_tasks','actor_user_id','users','CASCADE'),
    ('job_scanner_tasks','actor_user_id','users','CASCADE')
  ) AS items(table_name,column_name,parent_name,delete_action)
  LOOP
    FOR fk IN SELECT c.conname FROM pg_constraint c JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=ANY(c.conkey)
      WHERE c.contype='f' AND c.conrelid=to_regclass(item.table_name) AND c.confrelid=to_regclass(item.parent_name) AND a.attname=item.column_name
    LOOP EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I',item.table_name,fk.conname); END LOOP;
    EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (%I) REFERENCES %I(id) ON DELETE %s',
      item.table_name,item.table_name||'_'||item.column_name||'_deletion_fk',item.column_name,item.parent_name,item.delete_action);
  END LOOP;
END $$;

-- An FK cascade may erase a ledger only after the account itself is gone.
-- A surviving ledger may only lose an actor/website whose parent was erased.
-- Ordinary UPDATE, DELETE and TRUNCATE remain forbidden, with no spoofable GUC bypass.
CREATE OR REPLACE FUNCTION token_ledger_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='TRUNCATE' THEN RAISE EXCEPTION 'Token transactions are append-only; post a correcting transaction'; END IF;
  IF pg_trigger_depth()>1 AND TG_OP IN ('UPDATE','DELETE') AND NOT EXISTS(SELECT 1 FROM workspaces WHERE id=OLD.workspace_id) THEN
    IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;
  IF pg_trigger_depth()>1 AND TG_OP='UPDATE' AND (to_jsonb(NEW)-'actor_user_id'-'actor_deleted'-'website_id')=(to_jsonb(OLD)-'actor_user_id'-'actor_deleted'-'website_id')
    AND (NEW.actor_user_id IS NOT DISTINCT FROM OLD.actor_user_id OR
      (NEW.actor_user_id IS NULL AND OLD.actor_user_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM users WHERE id=OLD.actor_user_id)))
    AND (NEW.website_id IS NOT DISTINCT FROM OLD.website_id OR
      (NEW.website_id IS NULL AND OLD.website_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM websites WHERE id=OLD.website_id)))
    AND NEW.actor_deleted=OLD.actor_deleted
    AND (NEW.actor_user_id IS DISTINCT FROM OLD.actor_user_id OR NEW.website_id IS DISTINCT FROM OLD.website_id)
  THEN
    NEW.actor_deleted := OLD.actor_deleted OR NEW.actor_user_id IS DISTINCT FROM OLD.actor_user_id;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Token transactions are append-only; post a correcting transaction';
END $$;
CREATE OR REPLACE FUNCTION token_actor_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.actor_deleted THEN RAISE EXCEPTION 'A new transaction cannot have a deleted actor'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS token_actor_insert_guard ON token_transactions;
CREATE TRIGGER token_actor_insert_guard BEFORE INSERT ON token_transactions FOR EACH ROW EXECUTE FUNCTION token_actor_insert_guard();

CREATE OR REPLACE FUNCTION account_delete_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE actor uuid := nullif(current_setting('app.user_id',true),'')::uuid;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM platform_administrators a JOIN users u ON u.id=a.user_id WHERE a.user_id=actor AND u.disabled_at IS NULL)
  THEN RAISE EXCEPTION 'Platform administrator access required' USING ERRCODE='42501'; END IF;
  IF TG_TABLE_NAME='users' THEN
    IF OLD.id=actor OR EXISTS(SELECT 1 FROM workspace_memberships WHERE user_id=OLD.id) OR EXISTS(SELECT 1 FROM workspaces WHERE owner_user_id=OLD.id)
    THEN RAISE EXCEPTION 'Only unassociated users other than the current administrator can be erased' USING ERRCODE='42501'; END IF;
  END IF;
  RETURN OLD;
END $$;
DROP TRIGGER IF EXISTS account_delete_guard ON workspaces;
CREATE TRIGGER account_delete_guard BEFORE DELETE ON workspaces FOR EACH ROW EXECUTE FUNCTION account_delete_guard();
DROP TRIGGER IF EXISTS user_delete_guard ON users;
CREATE TRIGGER user_delete_guard BEFORE DELETE ON users FOR EACH ROW EXECUTE FUNCTION account_delete_guard();
DROP POLICY IF EXISTS ownership_request_platform_delete ON website_ownership_requests;
CREATE POLICY ownership_request_platform_delete ON website_ownership_requests FOR DELETE USING (
 EXISTS(SELECT 1 FROM platform_administrators a WHERE a.user_id=nullif(current_setting('app.user_id',true),'')::uuid));

-- Queue payloads carry user IDs as well as workspace IDs. These references prevent
-- a stale worker from recreating tasks for an erased user in another workspace.

SET CONSTRAINTS ALL DEFERRED;

ALTER TABLE websites FORCE ROW LEVEL SECURITY;

DO $$
DECLARE recorded text; history_complete boolean;
BEGIN
  IF to_regclass('schema_migrations') IS NULL THEN
    RAISE NOTICE 'Recovery completed. No migration-history table exists; no history was fabricated.';
    RETURN;
  END IF;
  SELECT checksum INTO recorded FROM schema_migrations WHERE name='015_account_deletion.sql';
  IF recorded IS NOT NULL AND recorded<>'3a77117d2070c92e5a387f0e381f02de09314f5cbd98d7ea83bc41701bd2ec84' THEN
    RAISE EXCEPTION 'Migration 015 has a different recorded checksum. Recovery stopped; migration history was not overwritten.';
  END IF;
  IF recorded IS NULL THEN
    SELECT count(*)=14 INTO history_complete FROM (VALUES
      ('001_accounts.sql','99152fee07a4a4c8e3c9a5883d925ef583da649d28528c55366cb6e1fda03a1e'),
      ('002_job_tokens.sql','03ffb938878e65d1aa9cae73c08ab54473915c3ad5022428792b9f7e03b9113d'),
      ('003_workspaces.sql','753c8d373c0b9adba94e1820ef79523794a59b35a090b204ebafb2a0eca021da'),
      ('004_stripe_billing.sql','b4411ffc13977aabc1599c467a831de8c19ac55a16288160e4fa02a43f8664e0'),
      ('005_token_ledger.sql','fd292a7695cb46b3d2bf51eb118f1a7293b403c191dfb57acb551925fce77e9b'),
      ('006_build_deploy_queue.sql','821f755322e1b93aea6412b42701c28a4f5b7ef2115b97c1178ddaacd9dd231d'),
      ('007_onboarding_validation.sql','c3069515360fce2b3d99825ce1e960375f6ad3de30bb52bc6b79719ed73b2ad5'),
      ('008_staged_onboarding.sql','def15b9305fc201a6496043b0fca6785dba676e24d9192eb9f6758b8556eb060'),
      ('009_plugin_onboarding.sql','2d2557efba8f1c310e507142490dfec9fc051ba193eae3fb9d2542d62375b459'),
      ('010_onboarding_progress.sql','7d5b5fdaa15ceda68b712e0ccd7836951a6534742f3a14e58d5eb47ac10ff2dd'),
      ('011_token_spend_reservations.sql','581de62f299e3793e91fedde54b11a69563244315eba7d00b06690210883348f'),
      ('012_platform_website_read.sql','c00fe2bb988ef689cf2ba758d6820f291628182a6ff7542aad62c881f3f53cf1'),
      ('013_job_scanner.sql','2aa375233da20ec9bf26ac48ac713098d943e4630729ce7945c11195110125fd'),
      ('014_website_ownership.sql','41a07c9cbcab53981cc6adc58887193efcebe8d3b341e4ca35bf753f2d3c166d')
    ) expected(name,checksum) JOIN schema_migrations applied USING(name,checksum);
    IF history_complete THEN
      INSERT INTO schema_migrations(name,checksum) VALUES('015_account_deletion.sql','3a77117d2070c92e5a387f0e381f02de09314f5cbd98d7ea83bc41701bd2ec84');
    ELSE
      RAISE NOTICE 'Recovery completed. Earlier tracked migration history is incomplete or differs; migration 015 was not marked applied.';
    END IF;
  END IF;
END $$;
COMMIT;

-- Success summary: the website protection and ledger FK must both report true.
SELECT
  (SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE oid='websites'::regclass) AS website_rls_restored,
  (SELECT convalidated FROM pg_constraint WHERE conrelid='token_transactions'::regclass AND conname='token_transactions_website_id_deletion_fk') AS ledger_website_fk_validated;
