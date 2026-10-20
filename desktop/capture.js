"use strict";

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { missingRuntimeMessage, resolveAudioBinary } = require("./runtime-paths");

function missingBinaryError(name, packaged) {
  return new Error(missingRuntimeMessage(name, { packaged }).body);
}

function recArgs(micPath) {
  return ["-b", "16", micPath, "rate", "16000", "channels", "1"];
}

function rawToWavArgs(rawPath, wavPath) {
  return [
    "-t", "raw", "-r", "16000", "-e", "signed-integer", "-b", "16",
    "-c", "1", rawPath, wavPath,
  ];
}

function isSilentPcmFile(filePath) {
  let descriptor;
  try {
    descriptor = fs.openSync(filePath, "r");
    const chunk = Buffer.alloc(65_536);
    while (true) {
      const bytes = fs.readSync(descriptor, chunk, 0, chunk.length, null);
      if (bytes === 0) return true;
      for (let index = 0; index < bytes; index += 1) {
        if (chunk[index] !== 0) return false;
      }
    }
  } catch (_) {
    return false;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function waitForExit(child, signal, timeoutMs = 10_000) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    child.once("close", finish);
    try { child.kill(signal); } catch (_) { finish(); }
    setTimeout(finish, timeoutMs).unref();
  });
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "ignore" });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${path.basename(command)} exited ${code}`));
    });
  });
}

class AudioCapture {
  constructor(options = {}) {
    this.recordingsDir = options.recordingsDir;
    this.audioTeePath = options.audioTeePath;
    // Callers pass resolved paths; null means the packaged runtime is absent (fail closed).
    this.packaged = Boolean(options.packaged);
    const devDeps = { env: process.env, isPackaged: false, existsSync: fs.existsSync };
    this.recBin = "recBin" in options ? options.recBin : resolveAudioBinary("rec", devDeps);
    this.soxBin = "soxBin" in options ? options.soxBin : resolveAudioBinary("sox", devDeps);
    this.spawn = options.spawn || spawn;
    this.onError = options.onError || (() => {});
    this.onSystemAudioUnavailable = options.onSystemAudioUnavailable || (() => {});
    this.active = null;
  }

  start(prefix) {
    if (this.active) throw new Error("recording already active");
    const captureSystem = Boolean(this.audioTeePath && fs.existsSync(this.audioTeePath));
    if (!this.recBin) throw missingBinaryError("rec", this.packaged);
    if (captureSystem && !this.soxBin) throw missingBinaryError("sox", this.packaged);
    fs.mkdirSync(this.recordingsDir, { recursive: true, mode: 0o700 });
    fs.chmodSync(this.recordingsDir, 0o700);
    const micPath = path.join(this.recordingsDir, `${prefix}_mic.wav`);
    const rawPath = path.join(this.recordingsDir, `${prefix}_system.raw`);
    const outputPath = path.join(this.recordingsDir, `${prefix}.wav`);
    const mic = this.spawn(this.recBin, recArgs(micPath), {
      stdio: ["ignore", "ignore", "pipe"],
    });
    if (mic.stderr) mic.stderr.on("data", () => {});
    mic.on("error", (error) => {
      this.onError(error && error.code === "ENOENT" ? missingBinaryError("rec", this.packaged) : error);
    });
    let system = null;
    let systemStream = null;
    if (captureSystem) {
      systemStream = fs.createWriteStream(rawPath);
      system = this.spawn(
        this.audioTeePath,
        ["--sample-rate", "16000", "--chunk-duration", "0.1"],
        { stdio: ["ignore", "pipe", "ignore"] },
      );
      system.stdout.pipe(systemStream);
      system.on("error", (error) => this.onError(error));
    }
    this.active = { prefix, micPath, rawPath, outputPath, mic, system, systemStream };
    return outputPath;
  }

  async stop() {
    if (!this.active) throw new Error("no active recording");
    const state = this.active;
    this.active = null;
    await waitForExit(state.mic, "SIGINT");
    if (state.system) await waitForExit(state.system, "SIGTERM", 5_000);
    if (state.systemStream) {
      await new Promise((resolve) => state.systemStream.end(resolve));
    }
    let systemWav = null;
    const hasSystemRaw = fs.existsSync(state.rawPath) && fs.statSync(state.rawPath).size > 0;
    const systemAudioSilent = hasSystemRaw && isSilentPcmFile(state.rawPath);
    if (hasSystemRaw && !systemAudioSilent) {
      if (!this.soxBin) throw missingBinaryError("sox", this.packaged);
      systemWav = state.rawPath.replace(".raw", ".wav");
      await run(this.soxBin, rawToWavArgs(state.rawPath, systemWav));
      await run(this.soxBin, ["-m", state.micPath, systemWav, state.outputPath]);
      try { fs.unlinkSync(state.rawPath); } catch (_) {}
    } else {
      fs.copyFileSync(state.micPath, state.outputPath);
      try { fs.unlinkSync(state.rawPath); } catch (_) {}
      if (systemAudioSilent) this.onSystemAudioUnavailable();
    }
    for (const file of [state.outputPath, state.micPath, systemWav].filter(Boolean)) {
      fs.chmodSync(file, 0o600);
    }
    // Per-stream WAVs are retained (0600): the Correction Inbox reprocess
    // re-transcribes these exact streams to preserve speaker attribution.
    return {
      audioPath: state.outputPath,
      micAudioPath: state.micPath,
      systemAudioPath: systemWav,
    };
  }

  async discard() {
    if (!this.active) return;
    const state = this.active;
    this.active = null;
    await waitForExit(state.mic, "SIGINT");
    if (state.system) await waitForExit(state.system, "SIGTERM", 2_000);
    if (state.systemStream) state.systemStream.end();
    const systemWav = state.rawPath.replace(".raw", ".wav");
    for (const file of [state.micPath, state.rawPath, systemWav, state.outputPath]) {
      try { fs.unlinkSync(file); } catch (_) {}
    }
  }
}

module.exports = { AudioCapture, isSilentPcmFile, rawToWavArgs, recArgs };
