CREATE TABLE borradores_plan (
  usuario_id BIGINT UNSIGNED NOT NULL,
  run_id CHAR(36) NOT NULL,
  revision INT UNSIGNED NOT NULL DEFAULT 0,
  estado ENUM('generando','abierto','guardando','guardado','cancelado') NOT NULL,
  datos JSON NULL,
  vence_en DATETIME(3) NOT NULL,
  PRIMARY KEY (usuario_id,run_id),
  KEY idx_borradores_plan_vence (vence_en),
  FOREIGN KEY (usuario_id) REFERENCES usuarios(id) ON DELETE CASCADE
) ENGINE=InnoDB;

INSERT INTO borradores_plan(usuario_id,run_id,estado,vence_en)
SELECT id,'00000000-0000-4000-8000-000000000017','cancelado',UTC_TIMESTAMP(3)
FROM usuarios WHERE es_prueba=1;
