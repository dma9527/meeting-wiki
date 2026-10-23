# Workflow

## Setup

```bash
python3 -m venv .venv
.venv/bin/pip install -e '.[dev]'
cd desktop && npm install && cd ..
```

## Verify

Run the full gate before any commit that you intend to push:

```bash
./scripts/verify-local.sh
```

It runs shell syntax checks, Ruff lint and format check, pytest, wheel and sdist builds with a privacy check of the sdist, `node --check` on desktop files, the desktop tests, `pip-audit`, `npm audit --audit-level=high`, and the public-safety scan.

Faster loops while working:

```bash
.venv/bin/ruff format meeting_wiki tests
.venv/bin/ruff check meeting_wiki tests
.venv/bin/pytest -q tests/test_config_privacy.py
cd desktop && node --test test/settings-window.test.js
cd desktop && npm test
```

The output of `verify-local.sh` is long. Redirect it to a file and read the tail.

When you add a new desktop JavaScript file, add it to three places: `scripts/verify-local.sh` (`node --check`), the `build.files` list in `desktop/package.json`, and the first-party list in `scripts/public-safety-scan.sh` if it is user-facing code.

## Remote CI

GitHub Actions (`.github/workflows/ci.yml`) runs on every push: Python 3.11 and 3.12, desktop on Node 20 and 22, and the public-safety scan. After pushing, wait for it with `gh run watch <id> --exit-status` and fix failures before reporting done. The Ubuntu runner label warning about Ubuntu 26 is informational.

## Adding behavior

1. Write a failing test first for bug fixes.
2. Change `meeting_wiki/config.py` before any desktop writer that emits that config.
3. Keep Python and desktop in sync. `desktop/managed-config.js` mirrors config rules, and `desktop/test/settings-window.test.js` loads generated TOML in the Python model.
4. Update the English guide and its `docs/zh-CN/` counterpart.
5. For any Settings text, follow the localization steps in `gotchas.md`.

## Versioning

A new candidate build needs a new version. Bump all of these together in one `chore(release): Bump Meeting Wiki to X.Y.Z` commit:

- `pyproject.toml`
- `desktop/package.json`
- `desktop/package-lock.json` (two `version` fields near the top)
- `docs/install-macos.md` (artifact names)

## Local package

```bash
./scripts/build-macos.sh > /tmp/mw-build.log 2>&1; tail -n 30 /tmp/mw-build.log
```

This stages the runtime, runs `npm ci` and the desktop tests, builds the app bundle, ad-hoc signs it, inventories it, scans it for personal paths, creates the DMG and ZIP from the signed bundle, verifies the signature of the copies inside both, and writes `SHA256SUMS`.

The build stops at the audio tool check unless `MEETING_WIKI_GPL_SOURCE_OFFER` points to a source-offer file the release owner has approved (known issue KI-3, see `docs/portable-runtime.md`). When blocked it writes `desktop/runtime.blocked.json` and exits without producing artifacts. Report the blocker to the owner. Do not work around it.

Each version also gets a Chinese installation guide at `desktop/dist/安装说明-Meeting-Wiki-X.Y.Z.md`, modeled on the previous one. These local test builds are unsigned and unnotarized.

Signed release builds use `scripts/release-macos.sh` and need Developer ID and notarization credentials (`scripts/release-macos.sh --check`). See `docs/releasing-macos.md`.

## Done means

- The relevant tests pass and you ran them, not assumed them.
- The full gate passed for anything you commit to push.
- Remote CI is green for anything you pushed.
- Docs, including the Chinese counterparts, match the behavior.
- The working tree is clean or only contains changes you can explain.
