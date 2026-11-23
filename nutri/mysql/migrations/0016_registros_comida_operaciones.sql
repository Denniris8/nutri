CREATE TABLE registros_comida_operaciones (
  request_id CHAR(36) NOT NULL PRIMARY KEY,
  registro_comida_id BIGINT UNSIGNED NOT NULL,
  FOREIGN KEY (registro_comida_id) REFERENCES registros_comidas(id) ON DELETE CASCADE
) ENGINE=InnoDB;

INSERT INTO registros_comida_operaciones (request_id, registro_comida_id)
SELECT request_id, registro_comida_id FROM registros_comida_interacciones
WHERE request_id IS NOT NULL;
