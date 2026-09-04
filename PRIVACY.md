# Privacy

Meeting Wiki is local-first and has no telemetry. The project maintainers do
not receive your recordings, transcripts, wiki, configuration, model prompts,
or usage data.

## Default local data flow

1. The desktop app records microphone and system audio only after you start a
   recording.
2. The configured transcription provider processes the audio.
3. The configured LLM provider receives the transcript and returns structured
   meeting facts.
4. Deterministic code renders local Markdown under `~/.meeting-wiki/`.
5. The local MCP server reads only `wiki/`; it never reads `private/`.

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

Local files persist until you delete them. The project does not retain backups.
Optional S3 retention is controlled by your bucket configuration. Deleting a
Markdown page does not automatically delete its audio or transcript; delete all
three when removing a meeting.

## Model downloads

Local model providers may download weights from third-party model registries.
Model weights can be several gigabytes and have their own licenses and privacy
policies.
