ALTER TABLE registros_entrenamientos
  ADD COLUMN request_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL AFTER external_activity_id,
  ADD UNIQUE KEY uq_registros_entrenamientos_usuario_request (usuario_id, request_id);
