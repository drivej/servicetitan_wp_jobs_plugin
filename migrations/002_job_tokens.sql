-- Allocation is an administrator operation; no client API can grant tokens.
ALTER TABLE users ADD COLUMN job_tokens integer NOT NULL DEFAULT 0 CHECK (job_tokens >= 0);
