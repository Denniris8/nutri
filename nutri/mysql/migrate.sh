#!/bin/sh
set -eu

mysql_db() {
  MYSQL_PWD="$DB_PASSWORD" mysql \
    --host="$DB_HOST" --port="$DB_PORT" --user="$DB_USER" --database="$DB_NAME" \
    --batch --raw --skip-column-names --default-character-set=utf8mb4 "$@"
}

mysql_db -e "CREATE TABLE IF NOT EXISTS schema_migrations (
  version VARCHAR(120) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  checksum BINARY(32) NOT NULL,
  applied_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci"

directory="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)/migrations"
for file in "$directory"/*.sql; do
  [ -f "$file" ] || continue
  name=${file##*/}
  case "$name" in
    [0-9][0-9][0-9][0-9]_*.sql) ;;
    *) echo "Nombre de migración inválido: $name" >&2; exit 1 ;;
  esac
  case "$name" in *[!a-zA-Z0-9_.-]*) echo "Nombre de migración inválido: $name" >&2; exit 1 ;; esac

  version=${name%.sql}
  checksum=$(sha256sum "$file" | cut -d ' ' -f 1)
  applied=$(mysql_db -e "SELECT LOWER(HEX(checksum)) FROM schema_migrations WHERE version='$version'")
  if [ -n "$applied" ]; then
    [ "$applied" = "$checksum" ] || { echo "Migración aplicada modificada: $name" >&2; exit 1; }
    continue
  fi

  echo "Aplicando migración $name"
  mysql_db < "$file"
  mysql_db -e "INSERT INTO schema_migrations (version, checksum) VALUES ('$version', UNHEX('$checksum'))"
done
