-- Earlier migrations can leave deferred balance checks pending in this batch.
SET CONSTRAINTS ALL IMMEDIATE;
-- Account erasure cascades its own records; surviving accounts retain their data.
-- Historical actor references are anonymized only when the user is actually erased.
ALTER TABLE audit_logs ALTER COLUMN user_id DROP NOT NULL;
ALTER TABLE workspace_invitations ALTER COLUMN invited_by DROP NOT NULL;
ALTER TABLE token_spend_operations ALTER COLUMN actor_user_id DROP NOT NULL;
ALTER TABLE token_transactions ADD COLUMN actor_deleted boolean NOT NULL DEFAULT false;
-- Locate the historical admin-adjustment actor check without relying on generated names.
DO $$
DECLARE c record;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint WHERE conrelid='token_transactions'::regclass AND contype='c'
    AND pg_get_constraintdef(oid) LIKE '%admin_adjustment%' AND pg_get_constraintdef(oid) LIKE '%actor_user_id%'
  LOOP EXECUTE format('ALTER TABLE token_transactions DROP CONSTRAINT %I',c.conname); END LOOP;
END $$;
ALTER TABLE token_transactions ADD CONSTRAINT token_actor_required CHECK (
 (kind <> 'admin_adjustment' OR actor_user_id IS NOT NULL OR actor_deleted) AND (NOT actor_deleted OR actor_user_id IS NULL));

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
    ('token_spend_operations','website_id','websites','CASCADE')
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
CREATE FUNCTION token_actor_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.actor_deleted THEN RAISE EXCEPTION 'A new transaction cannot have a deleted actor'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER token_actor_insert_guard BEFORE INSERT ON token_transactions FOR EACH ROW EXECUTE FUNCTION token_actor_insert_guard();

CREATE FUNCTION account_delete_guard() RETURNS trigger LANGUAGE plpgsql AS $$
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
CREATE TRIGGER account_delete_guard BEFORE DELETE ON workspaces FOR EACH ROW EXECUTE FUNCTION account_delete_guard();
CREATE TRIGGER user_delete_guard BEFORE DELETE ON users FOR EACH ROW EXECUTE FUNCTION account_delete_guard();
CREATE POLICY ownership_request_platform_delete ON website_ownership_requests FOR DELETE USING (
 EXISTS(SELECT 1 FROM platform_administrators a WHERE a.user_id=nullif(current_setting('app.user_id',true),'')::uuid));

-- Queue payloads carry user IDs as well as workspace IDs. These references prevent
-- a stale worker from recreating tasks for an erased user in another workspace.
ALTER TABLE build_deploy_tasks ADD COLUMN actor_user_id uuid GENERATED ALWAYS AS ((payload->>'userId')::uuid) STORED REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE job_scanner_tasks ADD COLUMN actor_user_id uuid GENERATED ALWAYS AS ((payload->>'userId')::uuid) STORED REFERENCES users(id) ON DELETE CASCADE;

SET CONSTRAINTS ALL DEFERRED;
