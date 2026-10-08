#!/usr/bin/env bash
set -euo pipefail
CONTAINER="${DB_CONTAINER:-voyya-verify-db}"
PORT="${DB_PORT:-5481}"
SUPER_PASSWORD="${DB_SUPER_PASSWORD:-pgsuper}"
APP_PASSWORD="${APP_PASSWORD:-app_verify_pw}"
API_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
BACKEND_DIR="$(cd "$API_DIR/../.." && pwd)"

export MSYS_NO_PATHCONV=1
docker exec "$CONTAINER" psql -U postgres -d postgres -v ON_ERROR_STOP=1 \
  -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='voyya' AND pid <> pg_backend_pid()" >/dev/null
docker exec "$CONTAINER" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS voyya" -c "CREATE DATABASE voyya" >/dev/null
docker exec "$CONTAINER" psql -U postgres -d voyya -v ON_ERROR_STOP=1 -c "CREATE EXTENSION IF NOT EXISTS postgis" >/dev/null
unset MSYS_NO_PATHCONV

export DATABASE_URL="postgresql://postgres:${SUPER_PASSWORD}@localhost:${PORT}/voyya"
(cd "$BACKEND_DIR" && pnpm --filter @voyya/api run db:release)
PROVISION_SQL="$(cygpath -w "$API_DIR/prisma/sql/01_provision_app_role.sql" 2>/dev/null || echo "$API_DIR/prisma/sql/01_provision_app_role.sql")"
MSYS_NO_PATHCONV=1 docker cp "$PROVISION_SQL" "$CONTAINER:/tmp/provision.sql"
MSYS_NO_PATHCONV=1 docker exec "$CONTAINER" psql -U postgres -d voyya -v ON_ERROR_STOP=1 -v app_pwd="$APP_PASSWORD" -f /tmp/provision.sql >/dev/null
MSYS_NO_PATHCONV=1 docker exec "$CONTAINER" psql -U postgres -d voyya -v ON_ERROR_STOP=1 -c "GRANT CREATE, USAGE ON SCHEMA public TO app_voyya" >/dev/null
(cd "$BACKEND_DIR" && pnpm --filter @voyya/api run db:seed)
