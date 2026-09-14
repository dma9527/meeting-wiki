# VibeVoice ASR BitNet Apple Silicon POC

Date: 2026-09-11

This is a synthetic, single-machine feasibility check. It contains no meeting
audio, transcript, title, participant, internal vocabulary, or private path.
It is not a production-quality model comparison.

## Environment

- Hardware: Apple M4 Pro, 48 GB memory.
- Runtime: `microsoft/VibeASR.cpp` commit
  `94cddff7216df8069cbf1b9095714b8327ffeedc`.
- Compiler: Apple Clang 21.
- Runtime build: native arm64, Accelerate, ARM dot-product, no OpenMP.
- Model: `microsoft/VibeVoice-ASR-BitNet`.
- Quantized model files: approximately 1.58 GB total.
- Inference: 8 threads, greedy decoding.
- Fixtures: locally generated speech using macOS system voices.

## Results

| Fixture | Context | WER | CER | RTF | Observation |
|---|---:|---:|---:|---:|---|
| 5.17 s English, one speaker | Current terms | 0.1429 | 0.0000 | 0.1432 | Correct characters; one compound-token word-boundary error. |
| 7.77 s English, two sequential voices | None | 0.1176 | 0.0412 | 0.1182 | Full content, plain text only. |
| 7.77 s English, two sequential voices | One hotword | 0.4706 | 0.4948 | 0.1070 | First utterance was omitted. |
| 7.02 s Mandarin, one speaker | None | Not meaningful for unsegmented CJK | 0.1613 | Not retained | Key phrase recognition errors. |
| 7.02 s Mandarin, one speaker | Four hotwords | 0.0000 | 0.0000 | 0.1762 | Hotwords corrected the synthetic sample. |
| 62.19 s repeated English | None | Not scored | Not scored | 0.1471 | Completed, but maximum RSS was about 14.9 GB. |
| 303.16 s repeated English | None | Not scored | Not scored | Failed | Terminated during VAE acoustic encoding; maximum RSS reached about 30 GB. |

Short English runs used roughly 2.3 to 2.9 GB peak memory footprint. Long-audio
memory grew far faster than model size.

## Capability finding

The C++ prompt builder states that plain text output is for the 1.5B model and
JSON output with `Start`, `End`, `Speaker`, and `Content` is for the 7B model.
The BitNet runtime replaces the original 7B language model with a 1.5B model.
In this POC, JSON mode produced no usable structured transcript.

Therefore the BitNet model does not currently provide the Who, When, What
contract needed for Meeting Wiki remote-speaker diarization.

## Decision

Do not add VibeVoice ASR BitNet as a Meeting Wiki provider now.

Reasons:

1. It does not provide usable speaker and timestamp structure in the tested
   BitNet configuration.
2. Hotword context was unstable across languages and caused severe content loss
   in the English two-voice fixture.
3. One-minute memory use was too high for common 16 GB Macs.
4. Five-minute input failed before decoding.
5. Short-audio speed was strong but did not materially beat the warmed MLX
   Whisper aggregate enough to offset memory and stability regressions.

Keep MLX Whisper as the default. Keep the public context-aware provider contract
and benchmark harness for future models. Any future VibeVoice evaluation should
start with a newer Apple-optimized runtime or a structured smaller model, then
repeat 30-minute and 60-minute stability gates before integration.

## Limitations

- Synthetic voices do not represent real meetings, accents, noise, or overlap.
- Only one Apple Silicon machine was measured.
- No 7B CUDA model was tested.
- The two-voice fixture was sequential, so no DER claim is made.
- MLX and BitNet cold-start behavior was not normalized into a formal release
  benchmark.
