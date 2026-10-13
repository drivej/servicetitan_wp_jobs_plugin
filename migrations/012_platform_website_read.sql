-- Platform administrators need website URLs for account support and member lookup.
-- This policy grants read-only access to website rows; writes remain governed by
-- the workspace membership policies.
CREATE POLICY website_platform_admin_read ON websites FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM platform_administrators a
    WHERE a.user_id = nullif(current_setting('app.user_id', true), '')::uuid
  ));
