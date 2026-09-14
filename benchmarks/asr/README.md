# ASR Benchmark

This harness compares Meeting Wiki transcription providers without publishing
meeting content. It is designed for synthetic, openly licensed, or locally held
consented audio.

## Privacy contract

Default result files contain only:

- provider and model identifiers;
- machine architecture;
- case, success, and failure counts;
- error class counts;
- aggregate WER, CER, approximate DER, timestamp MAE, RTF, cold-start time, peak RSS,
  and optional model size.

They do not contain audio paths, case identifiers, reference text, predicted
text, speaker names, meeting titles, or exception messages. Keep
`--include-case-metrics` disabled for real meeting benchmarks.

Never commit real audio, transcripts, manifests containing internal vocabulary,
or locally generated results. The repository safety scan rejects audio files.

## Manifest

Copy `manifest.example.json` outside the repository and edit it locally. Audio
paths may be absolute or relative to the manifest.

Each segment contains one active speaker. The current DER implementation samples
single-speaker frames and finds the best speaker-label permutation. It does not
score overlapping speakers as a full multi-label diarization metric. Timestamp
MAE pairs reference and predicted segments in order. Keep these limitations in
mind when interpreting results.

## Validate a manifest

```bash
python -m meeting_wiki.asr_benchmark \
  --config ~/.meeting-wiki/config.toml \
  --manifest /private/path/manifest.json \
  --output /private/path/validation.json \
  --dry-run
```

## Run a benchmark

```bash
python -m meeting_wiki.asr_benchmark \
  --config ~/.meeting-wiki/config.toml \
  --manifest /private/path/manifest.json \
  --model-path /private/path/model-directory \
  --output /private/path/aggregate.json
```

The configured `providers.transcription` implementation is used. Run the same
manifest with different provider configs to compare models while holding audio
and references constant.

## Suggested public fixture matrix

Use generated or redistributable fixtures for:

- single-speaker English;
- two-speaker English;
- three-speaker system audio;
- Chinese;
- English and Chinese code-switching;
- uncommon names and technical hotwords;
- background noise;
- overlapping speech;
- 30-minute stability;
- 60-minute stability.

Do not infer production readiness from short synthetic clips alone. Apple
Silicon integration requires evidence from long-form RTF, memory, stability, and

## Published synthetic findings

- [VibeVoice ASR BitNet Apple Silicon POC](vibevoice-bitnet-apple-silicon.md):
  fast on short clips, but no usable structured speaker output and unacceptable
  long-audio memory growth in the tested runtime.
speaker-correction metrics.
