# Gotchas

Each entry is a mistake that already happened or a trap found in review. The test or file named in parentheses proves it.

## CI

- The desktop CI jobs have no `.venv`. A desktop test that runs `.venv/bin/python` must skip when it is absent, or Node 20 and 22 fail with `ENOENT`. Keep pure JavaScript validation in separate tests from cross-language checks (`desktop/test/settings-window.test.js`).
- Local runs use a newer Node than CI. Check behavior on both Node 20 and 22 by reading CI logs, not by assuming local success.
- `gh run list --commit <short sha>` can return nothing right after a push. Wait a few seconds and list by branch.

## Config and languages

- `desktop/managed-config.js` accepts only the exact TOML shape that setup writes. Any new key or table must be added to `MANAGED_SCHEMA` and to the Python model, or Settings reports the config as hand edited and refuses to manage it.
- `replaceIdentitySection` must keep non-identity top-level keys such as a legacy `language`. Dropping them made saving a name fail the read-back check.
- Legacy `language` and `live.translation_target_language` still load. Python falls back per field using `model_fields_set`, so a partial `[languages]` table does not discard the other legacy values.
- Unsafe or unsupported legacy values must never reach a prompt, and they must not stop the app from starting. Python drops unsafe values to a safe default (`safe_legacy_language`). Settings shows unsupported values as an empty field with a migration notice and blocks provider and model saves until the user picks supported values.
- Legacy `language = "auto"` means automatic detection. Map it to `None`, not the string `auto`.
- `zh-CN` becomes `zh` only at the MLX Whisper and OpenAI-compatible transcription boundaries. Gemini receives `zh-CN`.
- Changing a language setting does not rewrite existing meetings or stored analysis snapshots. Only an explicit correction reprocess uses the current memory language.
- Language migration must not depend on setup state. A config that is managed but has no setup state still needs a way to fix its languages (`languageReadiness`).

## Settings and localization

- Every visible static string needs an `id` or stable selector and an entry in the `ZH` catalog in `desktop/renderer/settings-localization.js`. Headings without ids silently stay English.
- Dynamic text goes through `setLocalizedNode()` or `registerLocaleRenderer()` in `renderer/settings.js` so it re-renders when the UI language changes. Set `textContent` directly and it will stay in the old language.
- Apply the saved UI language before rendering panels, or the first paint uses the system language.
- Never infer meaning from translated or English substrings. A check for the word "allowed" turned a denied microphone into "allowed" because the denied text contained "until it is allowed". Localize from structured state: `microphonePermissionLine(status)`, `detectorLine(kind, state)`, `browserConnectionLine(name, connected)`.
- Chinese copy for privacy, visibility, and data-flow disclosures must keep every limit the English text states. Reviewers caught missing "meet.google.com tabs only", the supported browser list, the no-network-port statement, the 3 second check interval, and the tray and notification indicators. Add a test assertion for each disclosure you translate (`desktop/test/settings-localization.test.js`).
- Error strings thrown in the main process reach the renderer as plain English. Add each new one to `MESSAGE_ZH`.

## Recording and live

- Automatic recording must not send audio to a live provider in the first 10 seconds, because a meeting that ends in that window is discarded.
- Keep the specific terminal live issue reported by the child process. A later socket close must not overwrite it with `connection_lost`.
- Notify `no_adapter` once per provider configuration, and reset when the provider config changes.
- A stale Settings window must not overwrite recording defaults saved elsewhere. Saves send the expected previous values and the controller rejects a mismatch.

## Packaging

- `build-macos.sh` must create the DMG and ZIP from the bundle after it is re-signed. When electron-builder made them itself (`npm run build`), it skipped signing for lack of a Developer ID identity, so the installed copy had no sealed resources (`code has no resources but signature indicates they must be present`). macOS then reported "Meeting Wiki is damaged and cannot be opened" for downloaded copies. Verify the mounted DMG and extracted ZIP, not only `dist/mac-arm64` (`tests/test_release_script.py`).
- A downloaded local build is still rejected by Gatekeeper while it carries quarantine, even with a valid ad-hoc signature. Remove quarantine from the downloaded DMG or ZIP before opening it, because a quarantined DMG passes the flag to the copy and Finder reports the app as damaged during the drag to Applications. Then run `xattr -dr com.apple.quarantine` on the installed app.
- A blocked `build-macos.sh` run leaves `desktop/runtime.blocked.json` and no staged `desktop/runtime`. Both paths are gitignored. Built artifacts from earlier versions in `desktop/dist` are untouched.
- `desktop/runtime.previous.*` directories are stale leftovers from older runs. Do not rely on them.
- This Mac may have no installed app. A running or installed copy is separate from `desktop/dist`. Check `/Applications` and `~/Applications` before claiming what is installed.

## Review habits that paid off

- Ask an independent reviewer to check a language or config change against the exact contract, then re-review after each fix round. Four review rounds on the language work found a real data-loss bug and two disclosure gaps that tests had not caught.
- Verify a file path, a function name, and a CLI flag by reading the file before writing it into a doc.
