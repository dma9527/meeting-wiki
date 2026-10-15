# Portable Runtime (Stages 2 and 3)

The packaged app ships its own Python and audio tools at
`Meeting Wiki.app/Contents/Resources/runtime`. `desktop/runtime-paths.js`
resolves `runtime/bin/python`, `runtime/bin/rec`, and `runtime/bin/sox` there
in packaged mode, so the app needs no Homebrew, source checkout, or venv.

## Stage 2: stage the runtime

```bash
scripts/prepare-runtime-macos.sh
```

Builds `desktop/runtime/` on Apple Silicon:

| Path | Contents |
|------|----------|
| `bin/python` | uv-managed CPython 3.12.12 (python-build-standalone), relocatable |
| `lib/python3.12/site-packages` | `meeting-wiki` wheel plus online provider dependencies (`.[gemini]`, httpx, mcp, pydantic) from `scripts/runtime-requirements.txt` (sha256-pinned, binary wheels only) |
| `bin/sox`, `bin/rec` | SoX from the local Homebrew keg, `rec` is a symlink to `sox` |
| `lib/*.dylib` | SoX dylib closure, rewritten to `@loader_path` and ad-hoc re-signed |
| `licenses/` | License texts from each Homebrew keg, plus `SOURCE-OFFER.txt` |
| `manifest.json` | Python version, package list, per-component license and redistribution note, lock hash, `tree_sha256` |

Determinism: pinned interpreter and hash-locked wheels, hash-based `.pyc`
(`unchecked-hash`, so Python never writes into the signed bundle), stripped
installer metadata, fixed mtimes. Two runs produce the same `tree_sha256`.

Never staged: `config.toml`, API keys, jobs database, logs, audio,
transcripts, wiki, private meetings, or model files (`mlx-whisper` and other
local-model extras are excluded). A privacy scan fails the build if any of
these, a private key, an API-key-shaped string, or a host path (home, repo,
temp dir) appears in the tree.

Regenerate the lock after changing Python dependencies:

```bash
scripts/prepare-runtime-macos.sh --lock
```

### Audio tool sources

`rec` and `sox` come from `MEETING_WIKI_REC_BIN` / `MEETING_WIKI_SOX_BIN`, or
from `PATH`. Each binary and every non-system dylib it loads must live in a
Homebrew keg; the script reads the formula license (`brew info --json=v2`)
and the keg's COPYING/LICENSE files into the manifest before copying
anything. Exit code 3 means the tools cannot be bundled defensibly; no
runtime is left behind and the reasons are written to
`desktop/runtime.blocked.json`.

## Audio tool redistribution blocker

Homebrew SoX 14.4.2 links these components (versions from the build Mac):

| Component | License | Category |
|-----------|---------|----------|
| sox | GPL-2.0-or-later AND LGPL-2.1-or-later | copyleft |
| mad | GPL-2.0-or-later | copyleft |
| lame | LGPL-2.0-or-later | copyleft |
| libsndfile | LGPL-2.1-or-later | copyleft |
| mpg123 | LGPL-2.1-only | copyleft |
| flac | BSD-3-Clause AND GPL/LGPL (tools) AND public domain | copyleft |
| libogg, libvorbis, opus, opusfile | BSD-3-Clause | permissive |
| libpng | libpng-2.0 | permissive |

Shipping GPL/LGPL binaries inside the DMG is distribution. It requires the
license texts (staged automatically) and corresponding source, or a written
offer of it, for every copyleft component. The script cannot make that
commitment for the release owner, so by default it stops:

```text
AUDIO TOOLS BLOCKED: rec/sox cannot be bundled defensibly.
  - copyleft components flac, lame, libsndfile, mad, mpg123, sox require a
    written offer of corresponding source; set MEETING_WIKI_GPL_SOURCE_OFFER ...
```

To unblock, the release owner must do one of:

1. Publish the exact source tarballs and Homebrew formula revisions for each
   copyleft component (for example as release assets next to the DMG), write a
   source offer that points to them, and set
   `MEETING_WIKI_GPL_SOURCE_OFFER=/path/to/SOURCE-OFFER.txt`.
2. Replace SoX with a capture path that has no copyleft dependency (for
   example AVFoundation via the existing `audiotee` helper plus a permissive
   FLAC/WAV writer), then drop rec/sox from the runtime.

Until one of these is done, the DMG is portable for local testing only and
must not be published.

## Stage 3: package

`scripts/build-macos.sh` (local, unsigned) and `scripts/release-macos.sh`
(Developer ID, notarized) both run `prepare-runtime-macos.sh` before
electron-builder. `desktop/package.json` copies `desktop/runtime` to
`Resources/runtime` via `extraResources`. After the build,
`scripts/assert-packaged-runtime.sh` fails unless `runtime/bin/python`,
`runtime/bin/rec`, `runtime/bin/sox`, the manifest, and the source offer exist
and `python -c 'import meeting_wiki'`, `sox --version`, and `rec --version`
run from the bundle with an empty environment.

## Tests

```bash
bash tests/shell/test-prepare-runtime.sh   # blocked paths, layout, privacy, relocation, determinism
.venv/bin/python -m pytest tests/test_runtime_manifest.py tests/test_release_script.py
(cd desktop && npm test)                   # extraResources and runtime-paths agreement
```
