CREATE TABLE analisis_progreso_eventos (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  usuario_id BIGINT UNSIGNED NULL,
  flujo VARCHAR(20) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  operacion_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  evento VARCHAR(60) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  ocurrido_en DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  duracion_ms INT UNSIGNED NOT NULL,
  transcurrido_ms INT UNSIGNED NOT NULL,
  PRIMARY KEY (id),
  KEY idx_analisis_progreso_flujo_fecha (flujo, ocurrido_en),
  KEY idx_analisis_progreso_operacion (operacion_id, id),
  KEY idx_analisis_progreso_usuario_fecha (usuario_id, ocurrido_en),
  CONSTRAINT fk_analisis_progreso_usuario FOREIGN KEY (usuario_id) REFERENCES usuarios(id) ON DELETE SET NULL,
  CONSTRAINT chk_analisis_progreso_flujo CHECK (flujo IN ('comida','entrenamiento','plan'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
