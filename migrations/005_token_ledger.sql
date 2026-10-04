-- Separate operator privileges from customer-owned workspace roles. The runtime
-- role must receive SELECT only on platform_administrators (see setup guide).
CREATE TABLE platform_administrators (
  user_id uuid PRIMARY KEY REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE token_transactions (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  sequence bigint NOT NULL,
  kind text NOT NULL CHECK(kind IN ('opening','stripe_credit','spend','test_credit','admin_adjustment')),
  amount integer NOT NULL,
  requested_amount integer NOT NULL,
  discarded_amount bigint NOT NULL DEFAULT 0 CHECK(discarded_amount >= 0),
  balance_before integer NOT NULL CHECK(balance_before >= 0),
  balance_after integer NOT NULL CHECK(balance_after >= 0),
  actor_user_id uuid REFERENCES users(id),
  reference text NOT NULL CHECK(length(reference) BETWEEN 1 AND 250),
  reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 500),
  website_id uuid REFERENCES websites(id),
  job_id bigint,
  stripe_invoice_id text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(workspace_id,sequence),
  UNIQUE(workspace_id,reference),
  CHECK(balance_after::bigint = balance_before::bigint + amount),
  CHECK(requested_amount::bigint = amount::bigint + discarded_amount),
  CHECK(kind <> 'admin_adjustment' OR actor_user_id IS NOT NULL)
);
CREATE INDEX token_transactions_history ON token_transactions(workspace_id,sequence DESC);
-- Preserve only the known current balance. Historical grant rows and audit logs
-- remain available; their old cap effects cannot be reconstructed reliably.
LOCK TABLE workspaces IN ACCESS EXCLUSIVE MODE;
INSERT INTO token_transactions(id,workspace_id,sequence,kind,amount,requested_amount,balance_before,balance_after,reference,reason)
  SELECT id,id,1,'opening',job_tokens,job_tokens,0,job_tokens,'opening:ledger-v1','Opening balance at ledger migration' FROM workspaces;

CREATE FUNCTION token_ledger_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Token transactions are append-only; post a correcting transaction';
END;
$$;
CREATE TRIGGER token_ledger_immutable BEFORE UPDATE OR DELETE ON token_transactions
  FOR EACH ROW EXECUTE FUNCTION token_ledger_immutable();
CREATE TRIGGER token_ledger_no_truncate BEFORE TRUNCATE ON token_transactions
  FOR EACH STATEMENT EXECUTE FUNCTION token_ledger_immutable();

CREATE FUNCTION token_ledger_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE current_balance integer; last_sequence bigint; last_balance integer;
BEGIN
  SELECT job_tokens INTO current_balance FROM workspaces WHERE id=NEW.workspace_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Token workspace missing'; END IF;
  SELECT sequence,balance_after INTO last_sequence,last_balance FROM token_transactions
    WHERE workspace_id=NEW.workspace_id ORDER BY sequence DESC LIMIT 1;
  IF current_balance <> COALESCE(last_balance,0) THEN RAISE EXCEPTION 'Token ledger balance mismatch'; END IF;
  IF NEW.balance_before <> current_balance OR NEW.sequence <> COALESCE(last_sequence,0)+1 THEN
    RAISE EXCEPTION 'Token transaction does not continue the ledger';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER token_ledger_insert BEFORE INSERT ON token_transactions
  FOR EACH ROW EXECUTE FUNCTION token_ledger_insert();
CREATE FUNCTION token_ledger_apply() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE workspaces SET job_tokens=NEW.balance_after WHERE id=NEW.workspace_id;
  RETURN NEW;
END;
$$;
CREATE TRIGGER token_ledger_apply AFTER INSERT ON token_transactions
  FOR EACH ROW EXECUTE FUNCTION token_ledger_apply();
-- Reject direct balance edits and unlogged initial balances at transaction end.
CREATE FUNCTION token_balance_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE current_balance integer; ledger_balance bigint;
BEGIN
  SELECT job_tokens INTO current_balance FROM workspaces WHERE id=NEW.id;
  SELECT COALESCE(sum(amount),0) INTO ledger_balance FROM token_transactions WHERE workspace_id=NEW.id;
  IF current_balance::bigint <> ledger_balance THEN RAISE EXCEPTION 'Token balance must match the ledger'; END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER token_balance_check AFTER INSERT OR UPDATE ON workspaces
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION token_balance_check();
