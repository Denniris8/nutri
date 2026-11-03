INSERT INTO schema_migrations (version, checksum)
SELECT
  '0006_auth_login_rate_limits',
  UNHEX('e80e20911d1b73547dda1310e669adc00d8c46a16c613499b48e498900aeab57')
WHERE NOT EXISTS (
  SELECT 1
  FROM schema_migrations
  WHERE version = '0006_auth_login_rate_limits'
)
AND EXISTS (
  SELECT 1
  FROM information_schema.tables
  WHERE table_schema = DATABASE()
    AND table_name = 'auth_login_rate_limits'
    AND engine = 'InnoDB'
    AND table_collation = 'utf8mb4_unicode_ci'
)
AND (
  SELECT COUNT(*)
  FROM information_schema.columns
  WHERE table_schema = DATABASE()
    AND table_name = 'auth_login_rate_limits'
    AND is_nullable = 'NO'
    AND (
      (column_name = 'kind' AND column_type = 'enum(''ip'',''phone'')' AND character_set_name = 'ascii' AND collation_name = 'ascii_bin')
      OR (column_name = 'key_hash' AND column_type = 'binary(32)')
      OR (column_name = 'window_started_at' AND column_type = 'datetime' AND datetime_precision = 3)
      OR (column_name = 'attempts' AND column_type = 'smallint unsigned')
    )
) = 4
AND (
  SELECT COUNT(*)
  FROM information_schema.columns
  WHERE table_schema = DATABASE()
    AND table_name = 'auth_login_rate_limits'
) = 4
AND (
  SELECT COUNT(*)
  FROM information_schema.statistics
  WHERE table_schema = DATABASE()
    AND table_name = 'auth_login_rate_limits'
) = 3
AND (
  SELECT COUNT(*)
  FROM information_schema.statistics
  WHERE table_schema = DATABASE()
    AND table_name = 'auth_login_rate_limits'
    AND (
      (index_name = 'PRIMARY' AND non_unique = 0 AND seq_in_index = 1 AND column_name = 'kind')
      OR (index_name = 'PRIMARY' AND non_unique = 0 AND seq_in_index = 2 AND column_name = 'key_hash')
      OR (index_name = 'idx_auth_login_rate_limits_window' AND non_unique = 1 AND seq_in_index = 1 AND column_name = 'window_started_at')
    )
) = 3;
