CREATE TABLE users (
  id uuid PRIMARY KEY,
  google_subject text NOT NULL UNIQUE,
  email text NOT NULL,
  name text NOT NULL,
  avatar_url text,
  disabled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE sessions (
  token_hash text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_expiry ON sessions(expires_at);
CREATE TABLE oauth_attempts (
  state_hash text PRIMARY KEY,
  browser_hash text NOT NULL,
  secret text NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE INDEX oauth_attempts_expiry ON oauth_attempts(expires_at);
CREATE TABLE rate_limits (
  key text PRIMARY KEY,
  hits integer NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE INDEX rate_limits_expiry ON rate_limits(expires_at);
CREATE TABLE servicetitan_connections (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  environment text NOT NULL CHECK (environment IN ('integration', 'production')),
  tenant_id text NOT NULL CHECK (tenant_id ~ '^[0-9]{1,20}$'),
  credentials text NOT NULL,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id, id),
  UNIQUE(user_id, environment, tenant_id)
);
CREATE TABLE websites (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  connection_id uuid NOT NULL,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  url text NOT NULL,
  wordpress_credentials text,
  rest_base text NOT NULL DEFAULT 'st-jobs',
  zip_acf_field text NOT NULL DEFAULT 'my_zip_codes',
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id, id),
  UNIQUE(user_id, url),
  FOREIGN KEY(user_id, connection_id) REFERENCES servicetitan_connections(user_id, id)
);
CREATE INDEX websites_connection ON websites(user_id, connection_id);
CREATE TABLE audit_logs (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  action text NOT NULL,
  target_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_owner_time ON audit_logs(user_id, created_at DESC);

-- Runtime must use a non-superuser, non-BYPASSRLS role. FORCE also covers table owners.
ALTER TABLE servicetitan_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE servicetitan_connections FORCE ROW LEVEL SECURITY;
CREATE POLICY connection_owner ON servicetitan_connections
  USING (user_id = nullif(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (user_id = nullif(current_setting('app.user_id', true), '')::uuid);
ALTER TABLE websites ENABLE ROW LEVEL SECURITY;
ALTER TABLE websites FORCE ROW LEVEL SECURITY;
CREATE POLICY website_owner ON websites
  USING (user_id = nullif(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (user_id = nullif(current_setting('app.user_id', true), '')::uuid);
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs FORCE ROW LEVEL SECURITY;
CREATE POLICY audit_owner ON audit_logs
  USING (user_id = nullif(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (user_id = nullif(current_setting('app.user_id', true), '')::uuid);
