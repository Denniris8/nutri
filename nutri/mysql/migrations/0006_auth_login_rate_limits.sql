CREATE TABLE auth_login_rate_limits (
  kind ENUM('ip','phone') CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  key_hash BINARY(32) NOT NULL,
  window_started_at DATETIME(3) NOT NULL,
  attempts SMALLINT UNSIGNED NOT NULL,
  PRIMARY KEY (kind,key_hash),
  KEY idx_auth_login_rate_limits_window (window_started_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
