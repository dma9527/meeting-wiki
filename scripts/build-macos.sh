#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/desktop"
npm ci
npm test
npm run build

# Ad-hoc signing is for local development only. Public releases must use a
# Developer ID certificate and notarization in CI.
for app in dist/mac*/Meeting\ Wiki.app; do
  [ -d "$app" ] || continue
  codesign --force --deep --sign - "$app"
done

cd dist
shasum -a 256 ./*.dmg ./*.zip 2>/dev/null > SHA256SUMS || true
echo "Built artifacts under $ROOT/desktop/dist"
