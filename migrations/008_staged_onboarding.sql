ALTER TABLE websites ALTER COLUMN connection_id DROP NOT NULL;
ALTER TABLE websites DROP CONSTRAINT websites_workspace_id_connection_id_fkey;
ALTER TABLE websites ADD CONSTRAINT websites_workspace_connection_fk FOREIGN KEY(workspace_id,connection_id) REFERENCES servicetitan_connections(workspace_id,id);
