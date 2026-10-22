# Privacy

Meeting Wiki is local-first and has no telemetry. The project maintainers do
not receive your recordings, transcripts, wiki, configuration, model prompts,
or usage data.

## Default local data flow

1. The desktop app records microphone and system audio only after you start a
   recording, or, if you turned on automatic recording for Zoom or Google Meet
   in Settings, when you join a meeting. Both are off by default. See
   [docs/integrations.md](docs/integrations.md) for exactly what each
   integration inspects; neither reads meeting content or opens a network port.
   Automatic recordings are private by default on new installs; Settings can
   change this to follow your calendar or to the shared wiki.
2. The configured transcription provider processes the audio.
3. The configured LLM provider receives the transcript and returns structured
   meeting facts.
4. Deterministic code renders local Markdown under `~/.meeting-wiki/`.
5. The local MCP server reads only `wiki/`; it never reads `private/`.
6. URL resources you attach to meetings are stored locally in `memory.db` with
   the title and summary you type. Meeting Wiki never opens, fetches, or sends
   those URLs, and a resource on a private meeting stays private.
7. "Install Claude skill for meeting memory..." writes only a bundled instruction template with no
   meeting data to `~/.claude/skills/meeting-wiki-memory/SKILL.md`.
8. A local event journal, `events.db`, records fixed status codes, timestamps,
   job stages, and app version for troubleshooting. It never stores
   transcripts, titles, file paths, URLs, error text, or keys, and it is never
   sent anywhere.
9. When the webhook task provider is enabled, shared action items are queued in
   a local `outbox.db` before sending, so a retry cannot create a duplicate.

With MLX Whisper and Ollama, audio and text stay on your Mac. Selecting an
OpenAI-compatible, AWS, S3, calendar, or webhook provider sends the data needed
for that feature to the provider you configure. Review that provider's privacy
terms before enabling it.

## Private meetings

Meetings marked private are stored under `private/`. They do not update shared
people, topics, decisions, action items, indexes, or logs. They are not mirrored
to S3, returned by MCP, or sent to task providers.

## Recording consent

You are responsible for telling participants that recording/transcription is
active and obtaining any consent required by law, contract, workplace policy,
or platform terms. Laws differ across jurisdictions; some require every
participant's consent. Meeting Wiki does not determine whether recording is
lawful and does not provide legal advice.

Do not use Meeting Wiki for covert recording, surveillance, or recording people
who cannot consent.

## Retention and deletion

Local files persist until you delete them. Optional S3 retention is controlled
by your bucket configuration. Deleting a Markdown page does not automatically
delete its audio or transcript.

`meeting-wiki delete-preview` lists every artifact tied to a meeting (audio,
transcripts, analysis, wiki pages, memory, job rows, and task links) without
changing anything. `meeting-wiki retention-plan` reports what the optional
`[retention]` thresholds would remove, and also deletes nothing.

Encrypted backups are created only when you run `meeting-wiki backup-create`.
They never include API keys, `secrets.json`, `.env` files, or logs. The
passphrase is never stored. See `docs/data-ownership.md`.

## Model downloads

Local model providers may download weights from third-party model registries.
Model weights can be several gigabytes and have their own licenses and privacy
policies.
