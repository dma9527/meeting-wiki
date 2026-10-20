"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { createSecretStore } = require("../secret-store");

function createStore() {
  const files = new Map();
  const safeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(`encrypted:${value}`),
    decryptString: (value) => value.toString().replace("encrypted:", ""),
  };
  const fs = {
    readFileSync: (filePath) => {
      if (!files.has(filePath)) throw new Error("missing");
      return files.get(filePath);
    },
    writeFileSync: (filePath, value, options) => {
      assert.equal(options.mode, 0o600);
      files.set(filePath, value);
    },
    unlinkSync: (filePath) => files.delete(filePath),
  };
  return { store: createSecretStore({ safeStorage, fs, filePath: "/test/secrets.json" }), files };
}

test("API keys are encrypted before local persistence", () => {
  const { store, files } = createStore();

  store.save("openai", "test-key");

  assert.equal(store.read("openai"), "test-key");
  assert.doesNotMatch(files.get("/test/secrets.json"), /test-key/);
});

test("keys reject empty values and unavailable encryption", () => {
  const { store } = createStore();
  assert.throws(() => store.save("openai", ""), /required/);

  const unavailable = createSecretStore({
    safeStorage: { isEncryptionAvailable: () => false },
    fs: {},
    filePath: "/test/secrets.json",
  });
  assert.throws(() => unavailable.save("openai", "test-key"), /Keychain/);
});

test("has reports presence without decrypting", () => {
  const { store } = createStore();
  assert.equal(store.has("gemini"), false);
  store.save("gemini", "test-key");
  assert.equal(store.has("gemini"), true);
  assert.equal(store.has("online"), false);
});
