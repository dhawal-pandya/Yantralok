#!/usr/bin/env bash
#
# deploy: build the app and publish dist/ to the gh-pages branch.
# Can be run standalone or via the pre-push hook.
#
set -euo pipefail

REMOTE="origin"
DEPLOY_BRANCH="gh-pages"
BUILD_CMD="npm run build"
BUILD_DIR="dist"

REPO_ROOT="$(git rev-parse --show-toplevel)"
SRC_SHA="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
cd "$REPO_ROOT"

# Ensure npm is in PATH (hooks may not inherit full environment)
export PATH="/usr/local/bin:/usr/bin:/bin:$PATH"
if ! command -v npm &> /dev/null; then
  export PATH="$HOME/.nvm/versions/node/*/bin:$PATH"
fi

echo "[deploy] building ($BUILD_CMD)..."
$BUILD_CMD

[ -d "$BUILD_DIR" ] || { echo "[deploy] '$BUILD_DIR' not produced, aborting." >&2; exit 1; }

WORKTREE="$(mktemp -d)"
cleanup() { git worktree remove --force "$WORKTREE" 2>/dev/null || rm -rf "$WORKTREE"; }
trap cleanup EXIT

git worktree add --detach "$WORKTREE" >/dev/null

(
  cd "$WORKTREE"

  if git show-ref --verify --quiet "refs/heads/$DEPLOY_BRANCH"; then
    git switch "$DEPLOY_BRANCH"
  elif git ls-remote --exit-code --heads "$REMOTE" "$DEPLOY_BRANCH" >/dev/null 2>&1; then
    git switch -c "$DEPLOY_BRANCH" --track "$REMOTE/$DEPLOY_BRANCH"
  else
    git switch --orphan "$DEPLOY_BRANCH"
  fi

  find . -mindepth 1 -maxdepth 1 ! -name '.git' -exec rm -rf {} +
  cp -R "$REPO_ROOT/$BUILD_DIR/." .
  touch .nojekyll

  git add -A
  if git diff --cached --quiet; then
    echo "[deploy] gh-pages already current, nothing to deploy."
    exit 0
  fi

  git commit -q -m "deploy: build $SRC_SHA at $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  git push "$REMOTE" "$DEPLOY_BRANCH"
  echo "[deploy] published to $REMOTE/$DEPLOY_BRANCH."
)
