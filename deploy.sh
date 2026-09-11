#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# deploy.sh — publish @betadrop/cli to npm
#
# Usage:
#   ./deploy.sh          # defaults to "minor" bump (0.1.0 → 0.2.0)
#   ./deploy.sh patch    # bug-fix bump  (0.1.0 → 0.1.1)
#   ./deploy.sh minor    # feature bump  (0.1.0 → 0.2.0)
#   ./deploy.sh major    # breaking bump (0.1.0 → 1.0.0)
#   ./deploy.sh 1.3.0    # exact version (must be higher than current)
# ---------------------------------------------------------------------------

set -euo pipefail

# ── Colours ────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
YELLOW='\033[1;33m'
BOLD='\033[1m'
RESET='\033[0m'

ok()   { echo -e "${GREEN}✓${RESET} $*"; }
info() { echo -e "${CYAN}→${RESET} $*"; }
warn() { echo -e "${YELLOW}⚠${RESET}  $*"; }
fail() { echo -e "${RED}✗${RESET} $*" >&2; exit 1; }
step() { echo -e "\n${BOLD}$*${RESET}"; }

# ── Move to the CLI package root ────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

BUMP="${1:-minor}"

# ── 0. Pre-flight checks ───────────────────────────────────────────────────
step "0/6  Pre-flight checks"

# Node + npm present
command -v node >/dev/null 2>&1 || fail "Node.js is not installed."
command -v npm  >/dev/null 2>&1 || fail "npm is not installed."
ok "Node $(node -v)  npm $(npm -v)"

# Must be logged in to npm
NPM_USER=$(npm whoami 2>/dev/null) || fail "Not logged in to npm. Run: npm login"
ok "npm user: ${NPM_USER}"

# ...and logged in as an account that can actually publish THIS package.
#
# Checking `npm whoami` alone answers "am I logged in", never "as whom, and does that account own
# this package". On 2026-09-10 that gap cost two full publish attempts: the login was a personal
# account, @betadrop/cli belongs to `betadrop`, and npm answered with a 2FA error rather than a
# permissions one — so the whole diagnosis went to authenticator apps and access tokens while the
# actual problem was the account name printed one line above.
#
# Maintainer lists are public, so this needs no extra auth. Team-based access can grant publish
# rights to someone absent from this list, so it warns rather than aborting: the confirmation
# prompt below is where the decision belongs.
PKG_NAME_EARLY=$(node -p "require('./package.json').name")
PKG_OWNERS=$(npm owner ls "$PKG_NAME_EARLY" 2>/dev/null | awk '{print $1}' || true)
if [ -n "$PKG_OWNERS" ] && ! printf '%s\n' "$PKG_OWNERS" | grep -qx "$NPM_USER"; then
  warn "'${NPM_USER}' is not a listed maintainer of ${PKG_NAME_EARLY}."
  echo "    Maintainers: $(printf '%s ' $PKG_OWNERS)"
  echo "    Publishing will be refused unless that account has access through a team."
  echo "    Fix it one of these ways:"
  echo "      - log in as a maintainer:  npm logout && npm login"
  echo "      - or have a maintainer run: npm owner add ${NPM_USER} ${PKG_NAME_EARLY}"
  echo ""
fi

# git must be clean (no uncommitted changes)
if ! git diff --quiet || ! git diff --cached --quiet; then
  fail "Working tree has uncommitted changes. Commit or stash them first."
fi
ok "Git working tree is clean"

# Confirm the package name in package.json
PKG_NAME=$(node -p "require('./package.json').name")
CURRENT_VERSION=$(node -p "require('./package.json').version")
PUBLISHED_LATEST=$(npm view "$PKG_NAME" version 2>/dev/null || echo "none")

# The working tree can already be ahead of npm: a version bumped and committed on a branch, but
# never published. That is exactly how 0.3.0 sat unpublished for a week while the GitHub Action
# advertised a --channel flag that no published CLI had. Bumping again in that state skips the
# version the docs, the Action's version check and the release notes all name by number.
#
# So: publish what is in package.json when that version is not on npm yet and the caller named no
# bump. An explicit argument still wins, and a version that is already taken is still bumped.
if npm view "${PKG_NAME}@${CURRENT_VERSION}" version >/dev/null 2>&1; then
  VERSION_TAKEN=1
else
  VERSION_TAKEN=0
fi

if [ -z "${1:-}" ] && [ "$VERSION_TAKEN" -eq 0 ]; then
  PUBLISH_AS_IS=1
else
  PUBLISH_AS_IS=0
fi

info "Package : ${BOLD}${PKG_NAME}${RESET}"
info "Current : ${BOLD}v${CURRENT_VERSION}${RESET}"
info "On npm  : ${BOLD}${PUBLISHED_LATEST}${RESET}"
if [ "$PUBLISH_AS_IS" -eq 1 ]; then
  info "Action  : ${BOLD}publish v${CURRENT_VERSION} as-is${RESET} (not on npm yet, no bump)"
else
  [ "$VERSION_TAKEN" -eq 1 ] && [ -z "${1:-}" ] && \
    warn "v${CURRENT_VERSION} is already published; bumping instead."
  info "Bump    : ${BOLD}${BUMP}${RESET}"
fi

echo ""
read -r -p "$(echo -e "${YELLOW}Proceed with publishing?${RESET} [y/N] ")" CONFIRM
[[ "$CONFIRM" =~ ^[Yy]$ ]] || { warn "Aborted."; exit 0; }

# ── 1. Typecheck ───────────────────────────────────────────────────────────
step "1/6  Type-checking"
npm run typecheck
ok "No type errors"

# ── 2. Bump version ────────────────────────────────────────────────────────
step "2/6  Setting the version"
if [ "$PUBLISH_AS_IS" -eq 1 ]; then
  NEW_VERSION="$CURRENT_VERSION"
  ok "Publishing v${NEW_VERSION} as it stands in package.json"
else
  # npm version would also create a git commit + tag; we tag manually below.
  npm version "$BUMP" --no-git-tag-version
  NEW_VERSION=$(node -p "require('./package.json').version")
  ok "Version bumped: ${CURRENT_VERSION} → ${NEW_VERSION}"
fi

# ── 3. Build ───────────────────────────────────────────────────────────────
step "3/6  Building"
npm run build
ok "Built → dist/bd.js  ($(du -sh dist/bd.js 2>/dev/null | cut -f1))"

# ── 4. Dry-run preview ─────────────────────────────────────────────────────
step "4/6  Dry-run preview (files that will be published)"
# Bounded to npm's own tarball listing. The previous filter matched any indented line, which
# since npm 9 also catches the build output of `prepublishOnly` — `--dry-run` runs it too — so the
# "files that will be published" preview printed esbuild warnings instead of files.
npm publish --dry-run 2>&1 | sed -n '/Tarball Contents/,/Tarball Details/p' || true
echo ""

# ── 5. Publish to npm ──────────────────────────────────────────────────────
step "5/6  Publishing to npm"

# npm runs its own second-factor flow, and it must own the terminal to do it.
#
# An earlier version of this script prompted for a 6-digit code and piped npm through `tee` to
# keep a copy of the output. That broke the thing it was trying to help with: with stdout not a
# TTY, npm cannot prompt, so instead of opening its browser-based authentication it failed with
#
#   EOTP  This operation requires a one-time password.
#   Open this URL in your browser to authenticate: https://www.npmjs.com/auth/cli/...
#
# and the script then asked for a code that the account does not even generate — 2FA here is the
# web flow, not an authenticator app. So npm is left attached to the terminal and asked nothing:
# it knows whether it needs a second factor and how to collect one far better than this script.
#
# NPM_OTP is honoured for unattended runs (a granular token with 2FA bypass needs none).
if [ -n "${NPM_OTP:-}" ]; then
  NPM_CONFIG_OTP="$NPM_OTP" npm publish
else
  npm publish
fi || {
  echo ""
  warn "Publish failed. npm's own error is above."
  echo "    If it asked you to authenticate in a browser, open the npmjs.com URL it printed,"
  echo "    approve there, and run this script again — it resumes from a clean state, since"
  echo "    nothing is committed or tagged until the publish succeeds."
  echo "    If it said you lack permission, check: npm whoami  and  npm owner ls ${PKG_NAME}"
  fail "Nothing was published; the working tree is unchanged."
}
ok "${PKG_NAME}@${NEW_VERSION} published"

# ── 6. Commit, tag, push ───────────────────────────────────────────────────
step "6/6  Git commit + tag + push"

git add package.json package-lock.json
# Nothing to commit when the version was published as-is; the tag is still worth having.
if git diff --cached --quiet; then
  info "package.json unchanged (published as-is) - tagging only"
else
  git commit -m "chore(release): ${PKG_NAME}@${NEW_VERSION}"
fi
git tag "v${NEW_VERSION}"
git push origin HEAD
git push origin "v${NEW_VERSION}"
ok "Pushed commit and tag v${NEW_VERSION} to origin"

# ── Done ───────────────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}${BOLD}Released ${PKG_NAME}@${NEW_VERSION}${RESET}"
echo -e "  npm   : https://www.npmjs.com/package/${PKG_NAME}"
echo -e "  tag   : v${NEW_VERSION}"
echo -e "  install: npm install -g ${PKG_NAME}@${NEW_VERSION}"
