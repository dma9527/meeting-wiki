"use strict";

function createSecretStore({ safeStorage, fs, filePath }) {
  function requireEncryption() {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error("macOS Keychain encryption is unavailable");
    }
  }

  function readAll() {
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch (_) {
      return {};
    }
  }

  function save(provider, value) {
    if (!provider || !value || !value.trim()) {
      throw new Error("An API key is required");
    }
    requireEncryption();
    const secrets = readAll();
    secrets[provider] = safeStorage.encryptString(value.trim()).toString("base64");
    fs.writeFileSync(filePath, JSON.stringify(secrets), { encoding: "utf8", mode: 0o600 });
  }

  function read(provider) {
    requireEncryption();
    const value = readAll()[provider];
    if (typeof value !== "string") return "";
    try {
      return safeStorage.decryptString(Buffer.from(value, "base64"));
    } catch (_) {
      return "";
    }
  }

  // Presence only: never decrypts, so it is safe for UI state.
  function has(provider) {
    return typeof readAll()[provider] === "string";
  }

  function remove(provider) {
    const secrets = readAll();
    if (!(provider in secrets)) return;
    delete secrets[provider];
    fs.writeFileSync(filePath, JSON.stringify(secrets), { encoding: "utf8", mode: 0o600 });
  }

  return { save, read, has, remove };
}

module.exports = { createSecretStore };
