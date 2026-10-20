INSERT INTO notificaciones_usuario(usuario_id,categoria,estado,titulo,mensaje,creado_en)
SELECT id,'comida','guardado','[DATO SINTÉTICO DE PRUEBA] Ejemplo de alerta','Notificación sintética para validar el centro de alertas; no corresponde a un registro real.',UTC_TIMESTAMP(3)
FROM usuarios
WHERE es_prueba=1
  AND NOT EXISTS (
    SELECT 1 FROM notificaciones_usuario n
    WHERE n.usuario_id=usuarios.id AND n.titulo='[DATO SINTÉTICO DE PRUEBA] Ejemplo de alerta'
  );
