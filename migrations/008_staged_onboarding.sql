ALTER TABLE websites ALTER COLUMN connection_id DROP NOT NULL;
DO $$
DECLARE
  existing_fk record;
  connection_column smallint;
BEGIN
  SELECT attnum INTO connection_column
  FROM pg_attribute
  WHERE attrelid = 'websites'::regclass AND attname = 'connection_id' AND NOT attisdropped;

  -- PostgreSQL preserves the original constraint name when user_id was renamed
  -- to workspace_id, so the generated name varies with the schema's history.
  FOR existing_fk IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'websites'::regclass
      AND confrelid = 'servicetitan_connections'::regclass
      AND contype = 'f'
      AND connection_column = ANY(conkey)
  LOOP
    EXECUTE format('ALTER TABLE websites DROP CONSTRAINT %I', existing_fk.conname);
  END LOOP;

  ALTER TABLE websites
    ADD CONSTRAINT websites_workspace_connection_fk
    FOREIGN KEY(workspace_id, connection_id)
    REFERENCES servicetitan_connections(workspace_id, id);
END $$;
