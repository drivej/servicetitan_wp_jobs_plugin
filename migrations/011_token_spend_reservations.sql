ALTER TABLE token_transactions DROP CONSTRAINT token_transactions_kind_check;
ALTER TABLE token_transactions ADD CONSTRAINT token_transactions_kind_check
  CHECK(kind IN ('opening','stripe_credit','spend','spend_refund','test_credit','admin_adjustment'));

CREATE TABLE token_spend_operations (
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  operation_id text NOT NULL CHECK(operation_id ~ '^[a-zA-Z0-9:_-]{1,128}$'),
  website_id uuid NOT NULL REFERENCES websites(id),
  actor_user_id uuid NOT NULL REFERENCES users(id),
  job_id bigint,
  action text NOT NULL CHECK(length(action) BETWEEN 1 AND 80),
  fingerprint text NOT NULL CHECK(length(fingerprint)=64),
  state text NOT NULL CHECK(state IN ('reserved','settled','uncertain','failed','refunded')),
  attempt integer NOT NULL DEFAULT 1 CHECK(attempt > 0),
  result jsonb,
  error text,
  resolved_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(workspace_id, operation_id)
);
CREATE INDEX token_spend_operations_pending ON token_spend_operations(updated_at)
  WHERE state IN ('reserved','uncertain');
