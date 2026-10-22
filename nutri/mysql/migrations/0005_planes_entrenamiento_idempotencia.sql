ALTER TABLE planes_entrenamiento
  ADD COLUMN request_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL AFTER usuario_id,
  ADD UNIQUE KEY uq_planes_entrenamiento_usuario_request (usuario_id, request_id);
