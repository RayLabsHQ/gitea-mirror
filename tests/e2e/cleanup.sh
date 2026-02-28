#!/usr/bin/env bash
# ────────────────────────────────────────────────────────────────────────────────
# E2E Cleanup Script
# Removes all temporary data from previous E2E test runs.
#
# Usage:
#   ./tests/e2e/cleanup.sh          # cleanup everything
#   ./tests/e2e/cleanup.sh --soft   # keep container images, only remove volumes/data
# ────────────────────────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
COMPOSE_FILE="$SCRIPT_DIR/docker-compose.e2e.yml"

SOFT_CLEAN=false
if [[ "${1:-}" == "--soft" ]]; then
  SOFT_CLEAN=true
fi

# Detect container runtime (podman or docker)
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
  echo "[cleanup] WARNING: No container compose tool found. Skipping container cleanup."
  COMPOSE_CMD=""
  CONTAINER_CMD=""
fi

echo "╔══════════════════════════════════════════════════════════════╗"
echo "║              E2E Test Cleanup                                ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""

# ── 1. Stop and remove containers ─────────────────────────────────────────────
if [[ -n "$COMPOSE_CMD" ]] && [[ -f "$COMPOSE_FILE" ]]; then
  echo "[cleanup] Stopping E2E containers..."
  $COMPOSE_CMD -f "$COMPOSE_FILE" down --volumes --remove-orphans 2>/dev/null || true
  echo "[cleanup] ✓ Containers stopped and removed"
else
  echo "[cleanup] ⊘ No compose file or runtime found, skipping container teardown"
fi

# ── 2. Remove named volumes created by E2E compose ───────────────────────────
if [[ -n "$CONTAINER_CMD" ]]; then
  for vol in e2e-gitea-data; do
    full_vol_name="e2e_${vol}"
    # Try both with and without the project prefix
    for candidate in "$vol" "$full_vol_name" "tests_e2e_${vol}"; do
      if $CONTAINER_CMD volume inspect "$candidate" &>/dev/null 2>&1; then
        echo "[cleanup] Removing volume: $candidate"
        $CONTAINER_CMD volume rm -f "$candidate" 2>/dev/null || true
      fi
    done
  done
  echo "[cleanup] ✓ Named volumes cleaned"
fi

# ── 3. Kill leftover background processes from previous runs ──────────────────
echo "[cleanup] Checking for leftover processes..."

# Kill fake GitHub server
if pgrep -f "fake-github-server" &>/dev/null; then
  echo "[cleanup] Killing leftover fake-github-server process(es)..."
  pkill -f "fake-github-server" 2>/dev/null || true
fi

# Kill any stray node/tsx processes on our E2E ports (including git-server on 4590)
for port in 4580 4590 4321 3333; do
  pid=$(lsof -ti :"$port" 2>/dev/null || true)
  if [[ -n "$pid" ]]; then
    echo "[cleanup] Killing process on port $port (PID: $pid)..."
    kill -9 $pid 2>/dev/null || true
  fi
done

echo "[cleanup] ✓ Leftover processes cleaned"

# ── 4. Remove E2E database and data files ─────────────────────────────────────
echo "[cleanup] Removing E2E data files..."

# Remove test databases
rm -f "$PROJECT_ROOT/gitea-mirror.db" 2>/dev/null || true
rm -f "$PROJECT_ROOT/data/gitea-mirror.db" 2>/dev/null || true
rm -f "$PROJECT_ROOT/e2e-gitea-mirror.db" 2>/dev/null || true

# Remove test backup data
rm -rf "$PROJECT_ROOT/data/repo-backups"* 2>/dev/null || true

# Remove programmatically created test git repositories
if [[ -d "$SCRIPT_DIR/git-repos" ]]; then
  echo "[cleanup] Removing test git repos..."
  rm -rf "$SCRIPT_DIR/git-repos" 2>/dev/null || true
  echo "[cleanup] ✓ Test git repos removed"
fi

# Remove Playwright state/artifacts from previous runs
rm -rf "$SCRIPT_DIR/test-results" 2>/dev/null || true
rm -rf "$SCRIPT_DIR/playwright-report" 2>/dev/null || true
rm -rf "$SCRIPT_DIR/.auth" 2>/dev/null || true
rm -f "$SCRIPT_DIR/e2e-storage-state.json" 2>/dev/null || true

# Remove any PID files we might have created
rm -f "$SCRIPT_DIR/.fake-github.pid" 2>/dev/null || true
rm -f "$SCRIPT_DIR/.app.pid" 2>/dev/null || true

echo "[cleanup] ✓ Data files cleaned"

# ── 5. Remove temp directories ────────────────────────────────────────────────
echo "[cleanup] Removing temp directories..."
rm -rf /tmp/gitea-mirror-backup-* 2>/dev/null || true
rm -rf /tmp/e2e-gitea-mirror-* 2>/dev/null || true
echo "[cleanup] ✓ Temp directories cleaned"

# ── 6. Optionally remove container images ─────────────────────────────────────
if [[ "$SOFT_CLEAN" == false ]] && [[ -n "$CONTAINER_CMD" ]]; then
  echo "[cleanup] Pruning dangling images..."
  $CONTAINER_CMD image prune -f 2>/dev/null || true
  echo "[cleanup] ✓ Dangling images pruned"
else
  echo "[cleanup] ⊘ Skipping image cleanup (soft mode)"
fi

# ── 7. Remove node_modules/.cache artifacts from E2E ──────────────────────────
if [[ -d "$PROJECT_ROOT/node_modules/.cache/playwright" ]]; then
  echo "[cleanup] Removing Playwright cache..."
  rm -rf "$PROJECT_ROOT/node_modules/.cache/playwright" 2>/dev/null || true
  echo "[cleanup] ✓ Playwright cache removed"
fi

echo ""
echo "═══════════════════════════════════════════════════════════════"
echo " ✅ E2E cleanup complete"
echo "═══════════════════════════════════════════════════════════════"
