-- Workspace IDs initially equal the former account ID, preserving credential
-- encryption contexts and every existing connection, website, and token balance.
CREATE TABLE workspaces (
  id uuid PRIMARY KEY,
  owner_user_id uuid NOT NULL UNIQUE REFERENCES users(id),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  job_tokens integer NOT NULL DEFAULT 0 CHECK (job_tokens >= 0),
  created_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO workspaces(id,owner_user_id,name,job_tokens)
  SELECT id,id,left(name || '''s workspace',200),job_tokens FROM users;
CREATE TABLE workspace_memberships (
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  user_id uuid NOT NULL REFERENCES users(id),
  role text NOT NULL CHECK (role IN ('owner','admin','member')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(workspace_id,user_id)
);
CREATE UNIQUE INDEX workspace_one_owner ON workspace_memberships(workspace_id) WHERE role='owner';
CREATE INDEX memberships_user ON workspace_memberships(user_id);
INSERT INTO workspace_memberships(workspace_id,user_id,role) SELECT id,id,'owner' FROM users;
CREATE TABLE workspace_invitations (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  email text NOT NULL CHECK (email=lower(email)),
  role text NOT NULL CHECK (role IN ('admin','member')),
  token_hash text NOT NULL UNIQUE,
  invited_by uuid NOT NULL REFERENCES users(id),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  accepted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX invitations_workspace ON workspace_invitations(workspace_id,created_at DESC);
ALTER TABLE sessions ADD COLUMN workspace_id uuid REFERENCES workspaces(id);
UPDATE sessions SET workspace_id=user_id;
ALTER TABLE users DROP COLUMN job_tokens;

-- Drop owner policies before the migration updates existing rows (FORCE RLS).
DROP POLICY connection_owner ON servicetitan_connections;
DROP POLICY website_owner ON websites;
DROP POLICY audit_owner ON audit_logs;
ALTER TABLE audit_logs NO FORCE ROW LEVEL SECURITY;
ALTER TABLE audit_logs DISABLE ROW LEVEL SECURITY;
ALTER TABLE servicetitan_connections RENAME COLUMN user_id TO workspace_id;
ALTER TABLE websites RENAME COLUMN user_id TO workspace_id;
ALTER TABLE audit_logs ADD COLUMN job_id bigint;
ALTER TABLE audit_logs ADD COLUMN workspace_id uuid REFERENCES workspaces(id);
UPDATE audit_logs SET workspace_id=user_id;
ALTER TABLE audit_logs ALTER COLUMN workspace_id SET NOT NULL;
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs FORCE ROW LEVEL SECURITY;
-- The old ownership FKs referenced users; replace them with workspace FKs.
ALTER TABLE servicetitan_connections DROP CONSTRAINT servicetitan_connections_user_id_fkey;
ALTER TABLE servicetitan_connections ADD FOREIGN KEY(workspace_id) REFERENCES workspaces(id);
ALTER TABLE websites DROP CONSTRAINT websites_user_id_fkey;
ALTER TABLE websites ADD FOREIGN KEY(workspace_id) REFERENCES workspaces(id);

CREATE POLICY connection_read ON servicetitan_connections FOR SELECT USING (workspace_id=nullif(current_setting('app.workspace_id',true),'')::uuid AND EXISTS (SELECT 1 FROM workspace_memberships m WHERE m.workspace_id=servicetitan_connections.workspace_id AND m.user_id=nullif(current_setting('app.user_id',true),'')::uuid));
CREATE POLICY connection_insert ON servicetitan_connections FOR INSERT WITH CHECK (workspace_id=nullif(current_setting('app.workspace_id',true),'')::uuid AND EXISTS (SELECT 1 FROM workspace_memberships m WHERE m.workspace_id=servicetitan_connections.workspace_id AND m.user_id=nullif(current_setting('app.user_id',true),'')::uuid AND m.role IN ('owner','admin')));
CREATE POLICY connection_update ON servicetitan_connections FOR UPDATE USING (workspace_id=nullif(current_setting('app.workspace_id',true),'')::uuid AND EXISTS (SELECT 1 FROM workspace_memberships m WHERE m.workspace_id=servicetitan_connections.workspace_id AND m.user_id=nullif(current_setting('app.user_id',true),'')::uuid AND m.role IN ('owner','admin'))) WITH CHECK (workspace_id=nullif(current_setting('app.workspace_id',true),'')::uuid AND EXISTS (SELECT 1 FROM workspace_memberships m WHERE m.workspace_id=servicetitan_connections.workspace_id AND m.user_id=nullif(current_setting('app.user_id',true),'')::uuid AND m.role IN ('owner','admin')));
CREATE POLICY connection_delete ON servicetitan_connections FOR DELETE USING (workspace_id=nullif(current_setting('app.workspace_id',true),'')::uuid AND EXISTS (SELECT 1 FROM workspace_memberships m WHERE m.workspace_id=servicetitan_connections.workspace_id AND m.user_id=nullif(current_setting('app.user_id',true),'')::uuid AND m.role IN ('owner','admin')));
CREATE POLICY website_read ON websites FOR SELECT USING (workspace_id=nullif(current_setting('app.workspace_id',true),'')::uuid AND EXISTS (SELECT 1 FROM workspace_memberships m WHERE m.workspace_id=websites.workspace_id AND m.user_id=nullif(current_setting('app.user_id',true),'')::uuid));
CREATE POLICY website_insert ON websites FOR INSERT WITH CHECK (workspace_id=nullif(current_setting('app.workspace_id',true),'')::uuid AND EXISTS (SELECT 1 FROM workspace_memberships m WHERE m.workspace_id=websites.workspace_id AND m.user_id=nullif(current_setting('app.user_id',true),'')::uuid AND m.role IN ('owner','admin')));
CREATE POLICY website_update ON websites FOR UPDATE USING (workspace_id=nullif(current_setting('app.workspace_id',true),'')::uuid AND EXISTS (SELECT 1 FROM workspace_memberships m WHERE m.workspace_id=websites.workspace_id AND m.user_id=nullif(current_setting('app.user_id',true),'')::uuid AND m.role IN ('owner','admin'))) WITH CHECK (workspace_id=nullif(current_setting('app.workspace_id',true),'')::uuid AND EXISTS (SELECT 1 FROM workspace_memberships m WHERE m.workspace_id=websites.workspace_id AND m.user_id=nullif(current_setting('app.user_id',true),'')::uuid AND m.role IN ('owner','admin')));
CREATE POLICY website_delete ON websites FOR DELETE USING (workspace_id=nullif(current_setting('app.workspace_id',true),'')::uuid AND EXISTS (SELECT 1 FROM workspace_memberships m WHERE m.workspace_id=websites.workspace_id AND m.user_id=nullif(current_setting('app.user_id',true),'')::uuid AND m.role IN ('owner','admin')));
CREATE POLICY audit_workspace ON audit_logs
 USING (workspace_id=nullif(current_setting('app.workspace_id',true),'')::uuid AND EXISTS (
   SELECT 1 FROM workspace_memberships m WHERE m.workspace_id=audit_logs.workspace_id AND m.user_id=nullif(current_setting('app.user_id',true),'')::uuid))
 WITH CHECK (user_id=nullif(current_setting('app.user_id',true),'')::uuid AND workspace_id=nullif(current_setting('app.workspace_id',true),'')::uuid AND EXISTS (
   SELECT 1 FROM workspace_memberships m WHERE m.workspace_id=audit_logs.workspace_id AND m.user_id=audit_logs.user_id));
