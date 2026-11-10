# Migraciones MySQL

Añade cada cambio como un archivo SQL nuevo con nombre ordenable, por ejemplo `0001_descripcion.sql`. No edites una migración que ya se haya aplicado: crea otra que avance el esquema. El servicio `nutri` ejecuta `migrate.sh` antes de iniciar; tras `git pull`, recrea o reinicia ese servicio para aplicar las pendientes.

El migrador registra nombre, checksum SHA-256 y fecha en `schema_migrations`. Si cambia el contenido de una migración aplicada, detiene el arranque. Los DDL de MySQL pueden confirmar implícitamente; si falla una migración a medias, revisar el estado de la BD y preparar una migración correctiva antes de reintentar.

`migrate.sh` delega en `mysql/migrate.js`, que mantiene un único cliente `mysql` sin reconexión automática. Antes de consultar/aplicar migraciones adquiere un `GET_LOCK` por base de datos (espera máxima de 60 s); ese bloqueo se mantiene durante DDL, comprobaciones y registro de checksums hasta cerrar la conexión. Si no obtiene el bloqueo o falla la conexión, detiene el arranque. Todos los arranques concurrentes deben usar este runner; una versión antigua no respeta el bloqueo. Desplegar primero el runner sin arrancar migradores antiguos en paralelo. No usar el bloqueo como sustituto de una recuperación: una caída entre DDL y checksum aún requiere revisar el estado parcial antes de reintentar. Recuperación del cambio de runner: volver al anterior solo con un único migrador activo; no se modifican migraciones ni datos históricos por este cambio.

Las migraciones destructivas de datos deben documentar sus FKs y efectos secundarios, y requerir un respaldo MySQL externo verificado antes del despliegue. No se consideran reversibles salvo que se conserve un respaldo restaurable; documentar la recuperación hacia delante.
