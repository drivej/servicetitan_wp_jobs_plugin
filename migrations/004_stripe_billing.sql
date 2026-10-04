-- Billing records are server-managed, like workspaces and sessions. Browser
-- access always goes through authenticated membership checks.
CREATE TABLE workspace_billing (
  workspace_id uuid PRIMARY KEY REFERENCES workspaces(id),
  customer_id text UNIQUE,
  checkout_id text,
  checkout_key uuid,
  checkout_price text,
  checkout_expires_at timestamptz
);
CREATE TABLE stripe_token_grants (
  invoice_id text PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  subscription_id text NOT NULL,
  period_start bigint NOT NULL,
  tokens integer NOT NULL CHECK(tokens > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(subscription_id, period_start)
);
