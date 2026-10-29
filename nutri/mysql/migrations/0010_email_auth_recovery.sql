ALTER TABLE usuarios
  MODIFY celular_e164 VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NULL,
  ADD correo_electronico VARCHAR(254) CHARACTER SET ascii COLLATE ascii_bin NULL,
  ADD correo_verificado_en DATETIME(3) NULL,
  ADD UNIQUE KEY uq_usuarios_correo_electronico (correo_electronico);

ALTER TABLE auth_login_rate_limits
  MODIFY kind ENUM('ip','phone','email') CHARACTER SET ascii COLLATE ascii_bin NOT NULL;

CREATE TABLE tokens_cuenta_email (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  usuario_id BIGINT UNSIGNED NOT NULL,
  proposito ENUM('verificacion','recuperacion') CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  token_hash BINARY(32) NOT NULL,
  vence_en DATETIME(3) NOT NULL,
  consumido_en DATETIME(3) NULL,
  creado_en DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_tokens_cuenta_email_hash (token_hash),
  KEY idx_tokens_cuenta_email_usuario (usuario_id, proposito, creado_en),
  KEY idx_tokens_cuenta_email_expiracion (vence_en),
  CONSTRAINT fk_tokens_cuenta_email_usuario FOREIGN KEY (usuario_id) REFERENCES usuarios(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
