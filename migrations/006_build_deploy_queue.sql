-- Internal worker queue: never contains credentials or generated job copy.
-- Access through the server only, after websiteContext authorizes the scope.
CREATE TABLE build_deploy_tasks (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  website_id uuid NOT NULL REFERENCES websites(id) ON DELETE CASCADE,
  job_id bigint NOT NULL,
  state text NOT NULL CHECK (state IN ('queued','running','succeeded','failed')),
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE UNIQUE INDEX build_deploy_active ON build_deploy_tasks(workspace_id,website_id,job_id) WHERE state IN ('queued','running');
CREATE INDEX build_deploy_pending ON build_deploy_tasks(created_at) WHERE state='queued';
