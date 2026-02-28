#!/usr/bin/env bash
# ────────────────────────────────────────────────────────────────────────────────
# E2E Test Orchestrator
#
# Starts all required services, runs Playwright E2E tests, and tears down.
#
# Services managed:
#   1. Gitea instance        (Docker/Podman on port 3333)
#   2. Fake GitHub API       (Node.js on port 4580)
#   3. gitea-mirror app      (Astro dev server on port 4321)
#
# Usage:
#   ./tests/e2e/run-e2e.sh              # full run (cleanup → start → test → teardown)
#   ./tests/e2e/run-e2e.sh --no-build   # skip the Astro build step
#   ./tests/e2e/run-e2e.sh --keep       # don't tear down services after tests
#   ./tests/e2e/run-e2e.sh --ci         # CI-friendly mode (stricter, no --keep)
#
# Environment variables:
#   GITEA_PORT          (default: 3333)
#   FAKE_GITHUB_PORT    (default: 4580)
#   APP_PORT            (default: 4321)
#   SKIP_CLEANUP        (default: false)  set "true" to skip initial cleanup
#   BUN_CMD             (default: auto-detected bun or "npx --yes bun")
# ────────────────────────────────────────────────────────────────────────────────
set -euo pipefail

# ─── Resolve paths ────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
COMPOSE_FILE="$SCRIPT_DIR/docker-compose.e2e.yml"

# ─── Configuration ────────────────────────────────────────────────────────────
GITEA_PORT="${GITEA_PORT:-3333}"
FAKE_GITHUB_PORT="${FAKE_GITHUB_PORT:-4580}"
APP_PORT="${APP_PORT:-4321}"

GITEA_URL="http://localhost:${GITEA_PORT}"
FAKE_GITHUB_URL="http://localhost:${FAKE_GITHUB_PORT}"
APP_URL="http://localhost:${APP_PORT}"

NO_BUILD=false
KEEP_RUNNING=false
CI_MODE=false

for arg in "$@"; do
  case "$arg" in
    --no-build)  NO_BUILD=true ;;
    --keep)      KEEP_RUNNING=true ;;
    --ci)        CI_MODE=true ;;
    --help|-h)
      echo "Usage: $0 [--no-build] [--keep] [--ci]"
      exit 0
      ;;
  esac
done

# ─── Detect tools ─────────────────────────────────────────────────────────────

# Container runtime
COMPOSE_CMD=""
CONTAINER_CMD=""
if command -v podman-compose &>/dev/null; then
  COMPOSE_CMD="podman-compose"
  CONTAINER_CMD="podman"
elif command -v docker-compose &>/dev/null; then
  COMPOSE_CMD="docker-compose"
  CONTAINER_CMD="docker"
elif command -v docker &>/dev/null && docker compose version &>/dev/null 2>&1; then
  COMPOSE_CMD="docker compose"
  CONTAINER_CMD="docker"
else
  echo "ERROR: No container compose tool found. Install docker-compose or podman-compose."
  exit 1
fi

# Bun or fallback
if command -v bun &>/dev/null; then
  BUN_CMD="${BUN_CMD:-bun}"
elif command -v npx &>/dev/null; then
  # Use npx to run bun commands – works on CI with setup-bun action
  BUN_CMD="${BUN_CMD:-npx --yes bun}"
else
  echo "ERROR: Neither bun nor npx found."
  exit 1
fi

# Node/tsx for the fake GitHub server
if command -v tsx &>/dev/null; then
  TSX_CMD="tsx"
elif command -v npx &>/dev/null; then
  TSX_CMD="npx --yes tsx"
else
  echo "ERROR: Neither tsx nor npx found."
  exit 1
fi

echo "╔══════════════════════════════════════════════════════════════╗"
echo "║              E2E Test Orchestrator                          ║"
echo "╠══════════════════════════════════════════════════════════════╣"
echo "║  Container runtime : $COMPOSE_CMD"
echo "║  Bun command       : $BUN_CMD"
echo "║  TSX command       : $TSX_CMD"
echo "║  Gitea URL         : $GITEA_URL"
echo "║  Fake GitHub URL   : $FAKE_GITHUB_URL"
echo "║  App URL           : $APP_URL"
echo "║  CI mode           : $CI_MODE"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""

# ─── PID tracking for cleanup ─────────────────────────────────────────────────
FAKE_GITHUB_PID=""
APP_PID=""
EXIT_CODE=0

cleanup_on_exit() {
  local code=$?
  echo ""
  echo "────────────────────────────────────────────────────────────────"
  echo "[teardown] Cleaning up..."

  # Kill fake GitHub server
  if [[ -n "$FAKE_GITHUB_PID" ]] && kill -0 "$FAKE_GITHUB_PID" 2>/dev/null; then
    echo "[teardown] Stopping fake GitHub server (PID $FAKE_GITHUB_PID)..."
    kill "$FAKE_GITHUB_PID" 2>/dev/null || true
    wait "$FAKE_GITHUB_PID" 2>/dev/null || true
  fi
  rm -f "$SCRIPT_DIR/.fake-github.pid"

  # Kill app server
  if [[ -n "$APP_PID" ]] && kill -0 "$APP_PID" 2>/dev/null; then
    echo "[teardown] Stopping gitea-mirror app (PID $APP_PID)..."
    kill "$APP_PID" 2>/dev/null || true
    wait "$APP_PID" 2>/dev/null || true
  fi
  rm -f "$SCRIPT_DIR/.app.pid"

  # Stop containers (unless --keep)
  if [[ "$KEEP_RUNNING" == false ]]; then
    if [[ -n "$COMPOSE_CMD" ]] && [[ -f "$COMPOSE_FILE" ]]; then
      echo "[teardown] Stopping Gitea container..."
      $COMPOSE_CMD -f "$COMPOSE_FILE" down --volumes --remove-orphans 2>/dev/null || true
    fi
  else
    echo "[teardown] --keep flag set, leaving services running"
  fi

  echo "[teardown] Done."

  # Use the test exit code, not the cleanup exit code
  if [[ $EXIT_CODE -ne 0 ]]; then
    exit $EXIT_CODE
  fi
  exit $code
}

trap cleanup_on_exit EXIT INT TERM

# ─── Step 0: Cleanup previous run ────────────────────────────────────────────
if [[ "${SKIP_CLEANUP:-false}" != "true" ]]; then
  echo "┌──────────────────────────────────────────────────────────────┐"
  echo "│  Step 0: Cleanup previous E2E run                           │"
  echo "└──────────────────────────────────────────────────────────────┘"
  bash "$SCRIPT_DIR/cleanup.sh" --soft 2>/dev/null || true
  echo ""
fi

# ─── Step 1: Install dependencies ────────────────────────────────────────────
echo "┌──────────────────────────────────────────────────────────────┐"
echo "│  Step 1: Install dependencies                               │"
echo "└──────────────────────────────────────────────────────────────┘"
cd "$PROJECT_ROOT"
$BUN_CMD install 2>&1 | tail -5
echo "[deps] ✓ Dependencies installed"

# Install Playwright browsers if needed
if ! npx playwright install --dry-run chromium &>/dev/null 2>&1; then
  echo "[deps] Installing Playwright browsers..."
  npx playwright install chromium 2>&1 | tail -3
fi
# Always ensure system deps are available (needed in CI/fresh environments)
if [[ "$CI_MODE" == true ]]; then
  echo "[deps] Installing Playwright system dependencies..."
  npx playwright install-deps chromium 2>&1 | tail -5 || true
fi
echo "[deps] ✓ Playwright ready"
echo ""

# ─── Step 2: Build the app ──────────────────────────────────────────────────
if [[ "$NO_BUILD" == false ]]; then
  echo "┌──────────────────────────────────────────────────────────────┐"
  echo "│  Step 2: Build gitea-mirror                                 │"
  echo "└──────────────────────────────────────────────────────────────┘"
  cd "$PROJECT_ROOT"

  # Initialize the database
  echo "[build] Initializing database..."
  $BUN_CMD run manage-db init 2>&1 | tail -3 || true

  # Build the Astro project
  echo "[build] Building Astro project..."
  GITHUB_API_URL="$FAKE_GITHUB_URL" \
    BETTER_AUTH_SECRET="e2e-test-secret" \
    $BUN_CMD run build 2>&1 | tail -10

  echo "[build] ✓ Build complete"
  echo ""
else
  echo "[build] Skipped (--no-build flag)"
  echo ""
fi

# ─── Step 3: Start Gitea container ──────────────────────────────────────────
echo "┌──────────────────────────────────────────────────────────────┐"
echo "│  Step 3: Start Gitea container                              │"
echo "└──────────────────────────────────────────────────────────────┘"

$COMPOSE_CMD -f "$COMPOSE_FILE" up -d 2>&1

echo "[gitea] Waiting for Gitea to become healthy..."
GITEA_READY=false
for i in $(seq 1 60); do
  if curl -sf "${GITEA_URL}/api/v1/version" &>/dev/null; then
    GITEA_READY=true
    break
  fi
  printf "."
  sleep 2
done
echo ""

if [[ "$GITEA_READY" != true ]]; then
  echo "ERROR: Gitea did not become healthy within 120 seconds"
  echo "[gitea] Container logs:"
  $COMPOSE_CMD -f "$COMPOSE_FILE" logs --tail=30 2>/dev/null || true
  EXIT_CODE=1
  exit 1
fi

GITEA_VERSION=$(curl -sf "${GITEA_URL}/api/v1/version" | grep -o '"version":"[^"]*"' | cut -d'"' -f4)
echo "[gitea] ✓ Gitea is ready (version: ${GITEA_VERSION:-unknown})"
echo ""

# ─── Step 4: Start fake GitHub API ──────────────────────────────────────────
echo "┌──────────────────────────────────────────────────────────────┐"
echo "│  Step 4: Start fake GitHub API server                       │"
echo "└──────────────────────────────────────────────────────────────┘"

PORT=$FAKE_GITHUB_PORT $TSX_CMD "$SCRIPT_DIR/fake-github-server.ts" &
FAKE_GITHUB_PID=$!
echo "$FAKE_GITHUB_PID" > "$SCRIPT_DIR/.fake-github.pid"

echo "[fake-github] Started (PID: $FAKE_GITHUB_PID)"
echo "[fake-github] Waiting for server to be ready..."

FAKE_READY=false
for i in $(seq 1 30); do
  if curl -sf "${FAKE_GITHUB_URL}/___mgmt/health" &>/dev/null; then
    FAKE_READY=true
    break
  fi
  # Check if process died
  if ! kill -0 "$FAKE_GITHUB_PID" 2>/dev/null; then
    echo "ERROR: Fake GitHub server process died"
    EXIT_CODE=1
    exit 1
  fi
  printf "."
  sleep 1
done
echo ""

if [[ "$FAKE_READY" != true ]]; then
  echo "ERROR: Fake GitHub server did not start within 30 seconds"
  EXIT_CODE=1
  exit 1
fi

echo "[fake-github] ✓ Fake GitHub API is ready on $FAKE_GITHUB_URL"
echo ""

# ─── Step 5: Start gitea-mirror app ────────────────────────────────────────
echo "┌──────────────────────────────────────────────────────────────┐"
echo "│  Step 5: Start gitea-mirror application                     │"
echo "└──────────────────────────────────────────────────────────────┘"

cd "$PROJECT_ROOT"

# Reinitialize the database in case build step reset it
$BUN_CMD run manage-db init 2>&1 | tail -2 || true

# Start the app with E2E environment
GITHUB_API_URL="$FAKE_GITHUB_URL" \
  BETTER_AUTH_SECRET="e2e-test-secret" \
  BETTER_AUTH_URL="$APP_URL" \
  DATABASE_URL="file:data/gitea-mirror.db" \
  HOST="0.0.0.0" \
  PORT="$APP_PORT" \
  NODE_ENV="production" \
  PRE_SYNC_BACKUP_ENABLED="false" \
  ENCRYPTION_SECRET="e2e-encryption-secret-32char!!" \
  $BUN_CMD run start &
APP_PID=$!
echo "$APP_PID" > "$SCRIPT_DIR/.app.pid"

echo "[app] Started (PID: $APP_PID)"
echo "[app] Waiting for app to be ready..."

APP_READY=false
for i in $(seq 1 90); do
  # Try the health endpoint first, then fall back to root
  if curl -sf "${APP_URL}/api/health" &>/dev/null 2>&1 || \
     curl -sf -o /dev/null -w "%{http_code}" "${APP_URL}/" 2>/dev/null | grep -q "^[23]"; then
    APP_READY=true
    break
  fi
  # Check if process died
  if ! kill -0 "$APP_PID" 2>/dev/null; then
    echo ""
    echo "ERROR: gitea-mirror app process died"
    EXIT_CODE=1
    exit 1
  fi
  printf "."
  sleep 2
done
echo ""

if [[ "$APP_READY" != true ]]; then
  echo "ERROR: gitea-mirror app did not start within 180 seconds"
  EXIT_CODE=1
  exit 1
fi

echo "[app] ✓ gitea-mirror app is ready on $APP_URL"
echo ""

# ─── Step 6: Run Playwright E2E tests ──────────────────────────────────────
echo "┌──────────────────────────────────────────────────────────────┐"
echo "│  Step 6: Run Playwright E2E tests                           │"
echo "└──────────────────────────────────────────────────────────────┘"

cd "$PROJECT_ROOT"

# Ensure test-results directory exists
mkdir -p "$SCRIPT_DIR/test-results"

# Run Playwright
set +e
APP_URL="$APP_URL" \
  GITEA_URL="$GITEA_URL" \
  FAKE_GITHUB_URL="$FAKE_GITHUB_URL" \
  npx playwright test \
    --config "$SCRIPT_DIR/playwright.config.ts" \
    --reporter=list
PLAYWRIGHT_EXIT=$?
set -e

echo ""

if [[ $PLAYWRIGHT_EXIT -eq 0 ]]; then
  echo "═══════════════════════════════════════════════════════════════"
  echo " ✅ E2E tests PASSED"
  echo "═══════════════════════════════════════════════════════════════"
else
  echo "═══════════════════════════════════════════════════════════════"
  echo " ❌ E2E tests FAILED (exit code: $PLAYWRIGHT_EXIT)"
  echo "═══════════════════════════════════════════════════════════════"

  # On failure, dump some diagnostic info
  echo ""
  echo "[diag] Gitea container status:"
  $COMPOSE_CMD -f "$COMPOSE_FILE" ps 2>/dev/null || true
  echo ""
  echo "[diag] Gitea container logs (last 20 lines):"
  $COMPOSE_CMD -f "$COMPOSE_FILE" logs --tail=20 2>/dev/null || true
  echo ""
  echo "[diag] Fake GitHub health:"
  curl -sf "${FAKE_GITHUB_URL}/___mgmt/health" 2>/dev/null || echo "(unreachable)"
  echo ""
  echo "[diag] App health:"
  curl -sf "${APP_URL}/api/health" 2>/dev/null || echo "(unreachable)"
  echo ""

  # Point to HTML report
  if [[ -d "$SCRIPT_DIR/playwright-report" ]]; then
    echo "[diag] HTML report: $SCRIPT_DIR/playwright-report/index.html"
    echo "       Run: npx playwright show-report $SCRIPT_DIR/playwright-report"
  fi

  EXIT_CODE=$PLAYWRIGHT_EXIT
fi

# EXIT_CODE is used by the trap handler
exit $EXIT_CODE
