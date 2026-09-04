#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

FIRST_PARTY=()
while IFS= read -r -d '' file; do
  FIRST_PARTY+=("$file")
done < <(find meeting_wiki tests docs .github/workflows scripts -type f \
  ! -name 'public-safety-scan.sh' -print0)
for file in README.md SECURITY.md PRIVACY.md CONTRIBUTING.md NOTICE pyproject.toml config.example.toml desktop/main.js desktop/capture.js desktop/package.json desktop/entitlements.mac.plist; do
  [ -f "$file" ] && FIRST_PARTY+=("$file")
done

if grep -InE \
  'meetings\.amazon\.com|taskei\.amazon|quip-amazon|pippin\.sara|isengard|midway|dmawsome|@amazon\.com|[0-9]{12}' \
  "${FIRST_PARTY[@]}"; then
  echo "Internal/personal identifiers found." >&2
  exit 1
fi

if grep -InE \
  'AKIA[A-Z0-9]{16}|ASIA[A-Z0-9]{16}|aws_secret_access_key[[:space:]]*=' \
  "${FIRST_PARTY[@]}"; then
  echo "Credential-shaped material found." >&2
  exit 1
fi

if find . -type f \
  \( -name '*.wav' -o -name '*.mp3' -o -name '*.m4a' -o -name '*.db' \
     -o -name '*.db-wal' -o -name '*.db-shm' -o -name '*.pem' -o -name '*.key' \
     -o -name '.env' -o -name 'config.toml' \) \
  -not -path './.venv/*' -not -path './desktop/node_modules/*' \
  -not -path './desktop/dist/*' | grep .; then
  echo "Private/generated artifacts found in project tree." >&2
  exit 1
fi

echo "Public safety scan passed."
