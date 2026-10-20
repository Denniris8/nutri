# Migraciones MySQL

Añade cada cambio como un archivo SQL nuevo con nombre ordenable, por ejemplo `0001_descripcion.sql`. No edites una migración que ya se haya aplicado: crea otra que avance el esquema. El servicio `nutri` ejecuta `migrate.sh` antes de iniciar; tras `git pull`, recrea o reinicia ese servicio para aplicar las pendientes.

El migrador registra nombre, checksum SHA-256 y fecha en `schema_migrations`. Si cambia el contenido de una migración aplicada, detiene el arranque. Los DDL de MySQL pueden confirmar implícitamente; si falla una migración a medias, revisar el estado de la BD y preparar una migración correctiva antes de reintentar.
