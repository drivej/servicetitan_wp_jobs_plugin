ALTER TABLE workspaces
  ADD COLUMN onboarding_step smallint NOT NULL DEFAULT 1
  CHECK (onboarding_step BETWEEN 1 AND 3);

UPDATE workspaces w
SET onboarding_step = CASE
  WHEN EXISTS (
    SELECT 1
    FROM websites s
    JOIN servicetitan_connections c
      ON c.workspace_id = s.workspace_id AND c.id = s.connection_id
    WHERE s.workspace_id = w.id
      AND s.wordpress_credentials IS NOT NULL
      AND s.validated_at IS NOT NULL
      AND c.validated_at IS NOT NULL
  ) THEN 3
  WHEN EXISTS (
    SELECT 1
    FROM websites s
    WHERE s.workspace_id = w.id
      AND s.wordpress_credentials IS NOT NULL
      AND s.validated_at IS NOT NULL
  ) THEN 2
  ELSE 1
END;
