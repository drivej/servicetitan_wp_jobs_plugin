-- Internal background scanner queue; HTTP routes authorize the workspace/website.
CREATE TABLE job_scanner_tasks (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  website_id uuid NOT NULL REFERENCES websites(id) ON DELETE CASCADE,
  state text NOT NULL CHECK (state IN ('queued','running','drafting','succeeded','failed')),
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE UNIQUE INDEX job_scanner_active ON job_scanner_tasks(workspace_id,website_id) WHERE state IN ('queued','running','drafting');
CREATE INDEX job_scanner_pending ON job_scanner_tasks(created_at) WHERE state='queued';
CREATE INDEX job_scanner_latest ON job_scanner_tasks(workspace_id,website_id,created_at DESC);
