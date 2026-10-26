-- Durable desired state is committed before Stripe calls. Pending changes can be
-- retried without reopening membership or granting renewal tokens.
ALTER TABLE workspaces ADD COLUMN paused_at timestamptz;
ALTER TABLE workspace_billing ADD COLUMN pause_action text CHECK(pause_action IN ('pause','resume'));
ALTER TABLE workspace_billing ADD COLUMN pause_request_id uuid;
ALTER TABLE workspace_billing ADD CONSTRAINT pause_request_complete CHECK ((pause_action IS NULL)=(pause_request_id IS NULL));
CREATE TABLE workspace_pause_periods (
 id uuid PRIMARY KEY,
 workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 started_at timestamptz NOT NULL DEFAULT now(),
 ended_at timestamptz,
 CHECK(ended_at IS NULL OR ended_at>=started_at)
);
CREATE UNIQUE INDEX workspace_pause_open ON workspace_pause_periods(workspace_id) WHERE ended_at IS NULL;
CREATE INDEX workspace_pause_history ON workspace_pause_periods(workspace_id,started_at);

-- Protect every membership/invitation insertion, including old invitation links.
-- Use the same workspace lock as pause, billing grants, and team mutations.
CREATE FUNCTION block_paused_account_members() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM 1 FROM workspaces WHERE id=NEW.workspace_id AND paused_at IS NULL FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'This account is paused. Resume the account before adding users.' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER paused_membership_guard BEFORE INSERT ON workspace_memberships FOR EACH ROW EXECUTE FUNCTION block_paused_account_members();
CREATE TRIGGER paused_invitation_guard BEFORE INSERT ON workspace_invitations FOR EACH ROW EXECUTE FUNCTION block_paused_account_members();
-- Remember suppressed deliveries so later webhook retries cannot credit them.
CREATE TABLE workspace_paused_invoices (
 invoice_id text PRIMARY KEY,
 workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE
);
