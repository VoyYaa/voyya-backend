#!/usr/bin/env bash
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
export STATE_FILE="${STATE_FILE:?STATE_FILE es obligatorio}"
export API_LOG="${API_LOG:?API_LOG es obligatorio}"
OUT="${RESULTS_DIR:?RESULTS_DIR es obligatorio}"
mkdir -p "$OUT"
rm -f "$STATE_FILE"

failed=0
for script in 01-pilot 02-affiliation 03-company-b-drivers 04-platform-config 05-passenger-dispatch 06-settlement; do
  echo "=== $script"
  RESULTS_FILE="$OUT/$script.json" node "$HERE/$script.mjs" || failed=$((failed + 1))
done

if [ -n "${RESTART_API_CMD:-}" ]; then
  echo "=== reinicio de la API (limites de frecuencia en memoria)"
  eval "$RESTART_API_CMD"
fi

if [ -n "${ADMIN_DIR:-}" ]; then
  echo "=== consola real (Playwright)"
  (cd "$ADMIN_DIR" && E2E_REAL_MULTICOMPANY=1 BASE_URL="${ADMIN_URL:-http://localhost:5180}" E2E_BROWSER_CHANNEL="${E2E_BROWSER_CHANNEL:-chrome}" E2E_VIDEO=off \
    npx playwright test e2e/tests/integration --reporter=list --workers=1) || failed=$((failed + 1))
fi

if [ -n "${PASSENGER_WEB_URL:-}" ]; then
  echo "=== app del pasajero, target web"
  RESULTS_FILE="$OUT/07-mobile-web.json" SHOTS_DIR="$OUT/shots" PASSENGER_PHONE="${PASSENGER_PHONE:-3105550301}" node "$HERE/07-mobile-web.mjs" || failed=$((failed + 1))
fi

if [ -n "${PASSENGER_WEB_URL:-}" ]; then
  echo "=== app del pasajero, target web: bordes"
  RESULTS_FILE="$OUT/09-mobile-web-edge.json" SHOTS_DIR="$OUT/shots" PASSENGER_PHONE_EDGE="${PASSENGER_PHONE_EDGE:-3105550411}" node "$HERE/09-mobile-web-edge.mjs" || failed=$((failed + 1))
fi

echo "=== 08-concurrency"
RESULTS_FILE="$OUT/08-concurrency.json" node "$HERE/08-concurrency.mjs" || failed=$((failed + 1))

echo "scripts con fallos: $failed"
exit "$failed"
