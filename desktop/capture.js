"use strict";

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

function resolveBinary(name, envName) {
  if (process.env[envName]) return process.env[envName];
  for (const candidate of [`/opt/homebrew/bin/${name}`, `/usr/local/bin/${name}`]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return name;
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
    this.recBin = options.recBin || resolveBinary("rec", "MEETING_WIKI_REC_BIN");
    this.soxBin = options.soxBin || resolveBinary("sox", "MEETING_WIKI_SOX_BIN");
    this.spawn = options.spawn || spawn;
    this.onError = options.onError || (() => {});
    this.active = null;
  }

  start(prefix) {
    if (this.active) throw new Error("recording already active");
    fs.mkdirSync(this.recordingsDir, { recursive: true, mode: 0o700 });
    fs.chmodSync(this.recordingsDir, 0o700);
    const micPath = path.join(this.recordingsDir, `${prefix}_mic.wav`);
    const rawPath = path.join(this.recordingsDir, `${prefix}_system.raw`);
    const outputPath = path.join(this.recordingsDir, `${prefix}.wav`);
    const mic = this.spawn(this.recBin, recArgs(micPath), {
      stdio: ["ignore", "ignore", "pipe"],
    });
    if (mic.stderr) mic.stderr.on("data", () => {});
    mic.on("error", (error) => this.onError(error));
    let system = null;
    let systemStream = null;
    if (this.audioTeePath && fs.existsSync(this.audioTeePath)) {
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
    if (fs.existsSync(state.rawPath) && fs.statSync(state.rawPath).size > 0) {
      const systemWav = state.rawPath.replace(".raw", ".wav");
      await run(this.soxBin, rawToWavArgs(state.rawPath, systemWav));
      await run(this.soxBin, ["-m", state.micPath, systemWav, state.outputPath]);
      for (const file of [state.micPath, state.rawPath, systemWav]) {
        try { fs.unlinkSync(file); } catch (_) {}
      }
    } else {
      fs.renameSync(state.micPath, state.outputPath);
      try { fs.unlinkSync(state.rawPath); } catch (_) {}
    }
    fs.chmodSync(state.outputPath, 0o600);
    return state.outputPath;
  }

  async discard() {
    if (!this.active) return;
    const state = this.active;
    this.active = null;
    await waitForExit(state.mic, "SIGINT");
    if (state.system) await waitForExit(state.system, "SIGTERM", 2_000);
    if (state.systemStream) state.systemStream.end();
    for (const file of [state.micPath, state.rawPath, state.outputPath]) {
      try { fs.unlinkSync(file); } catch (_) {}
    }
  }
}

module.exports = { AudioCapture, rawToWavArgs, recArgs, resolveBinary };
