CREATE TABLE notificaciones_usuario (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  usuario_id BIGINT UNSIGNED NOT NULL,
  categoria ENUM('comida','entrenamiento','plan') NOT NULL,
  estado ENUM('requiere_respuesta','guardado','generado','error','resuelta') NOT NULL,
  titulo VARCHAR(120) NOT NULL,
  mensaje VARCHAR(2000) NOT NULL,
  referencia_id BIGINT UNSIGNED NULL,
  creado_en DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  leida_en DATETIME(3) NULL,
  PRIMARY KEY (id),
  KEY idx_notificaciones_usuario_no_leidas (usuario_id,leida_en,creado_en,id),
  CONSTRAINT fk_notificaciones_usuario FOREIGN KEY (usuario_id) REFERENCES usuarios(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
