-- Legacy websites remain unclaimed until authenticated administrator verification.
ALTER TABLE websites ADD COLUMN installation_id uuid;
ALTER TABLE websites ADD COLUMN canonical_url text;
ALTER TABLE websites ADD COLUMN ownership_verified_version integer;
CREATE UNIQUE INDEX websites_installation_owner ON websites(installation_id) WHERE installation_id IS NOT NULL;
CREATE UNIQUE INDEX websites_canonical_owner ON websites(canonical_url) WHERE installation_id IS NOT NULL;
ALTER TABLE websites ADD CONSTRAINT website_identity_complete CHECK (
 (installation_id IS NULL AND canonical_url IS NULL AND ownership_verified_version IS NULL) OR
 (installation_id IS NOT NULL AND canonical_url IS NOT NULL));
ALTER TABLE websites NO FORCE ROW LEVEL SECURITY;
UPDATE websites SET validated_at=NULL;
ALTER TABLE websites FORCE ROW LEVEL SECURITY;
UPDATE workspaces SET onboarding_step=1;

CREATE TABLE website_ownership_requests (
 id uuid PRIMARY KEY,
 requester_id uuid NOT NULL REFERENCES users(id),
 requester_workspace_id uuid NOT NULL REFERENCES workspaces(id),
 installation_id uuid NOT NULL,
 canonical_url text NOT NULL,
 kind text NOT NULL CHECK(kind IN ('access','dispute')),
 message text NOT NULL CHECK(length(message) BETWEEN 1 AND 2000),
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(requester_workspace_id,installation_id,kind)
);
ALTER TABLE website_ownership_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE website_ownership_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY ownership_request_insert ON website_ownership_requests FOR INSERT WITH CHECK (
 requester_id=nullif(current_setting('app.user_id',true),'')::uuid AND
 requester_workspace_id=nullif(current_setting('app.workspace_id',true),'')::uuid AND EXISTS (
 SELECT 1 FROM workspace_memberships m WHERE m.workspace_id=requester_workspace_id AND m.user_id=requester_id AND m.role IN ('owner','admin')));
CREATE POLICY ownership_request_read ON website_ownership_requests FOR SELECT USING (
 (requester_id=nullif(current_setting('app.user_id',true),'')::uuid AND requester_workspace_id=nullif(current_setting('app.workspace_id',true),'')::uuid) OR
 (kind='access' AND EXISTS (SELECT 1 FROM websites w JOIN workspace_memberships m ON m.workspace_id=w.workspace_id
 WHERE (w.installation_id=website_ownership_requests.installation_id OR w.canonical_url=website_ownership_requests.canonical_url)
 AND m.user_id=nullif(current_setting('app.user_id',true),'')::uuid AND m.role IN ('owner','admin'))) OR
 EXISTS(SELECT 1 FROM platform_administrators a WHERE a.user_id=nullif(current_setting('app.user_id',true),'')::uuid));
