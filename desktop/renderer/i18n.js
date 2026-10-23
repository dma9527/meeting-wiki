"use strict";

// Shared renderer localization. Each window supplies its own Chinese catalog; English is the
// text already in the page or the source string, so a missing entry falls back to English.
// Catalog values are plain text and are always written with textContent.

(function i18n(globalObject) {
  const LOCALES = Object.freeze(["system", "en", "zh-CN"]);

  function resolveLocale(choice, systemLocale = "en") {
    if (choice === "zh-CN" || choice === "en") return choice;
    return String(systemLocale || "").toLowerCase().startsWith("zh") ? "zh-CN" : "en";
  }

  function fill(text, vars) {
    if (!vars) return text;
    return text.replace(/\{([a-zA-Z]+)\}/g, (whole, name) =>
      Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : whole,
    );
  }

  // Swaps static text for every selector and restores the original English when switching back.
  function createStaticApplier(catalog) {
    const originalText = new WeakMap();
    const originalTitles = new WeakMap();
    return function applyStatic(documentObject, choice, systemLocale = "en") {
      const locale = resolveLocale(choice, systemLocale);
      documentObject.documentElement.lang = locale;
      if (Object.prototype.hasOwnProperty.call(catalog, "title")) {
        if (!originalTitles.has(documentObject)) originalTitles.set(documentObject, documentObject.title);
        documentObject.title = locale === "zh-CN" ? catalog.title : originalTitles.get(documentObject);
      }
      for (const [selector, text] of Object.entries(catalog)) {
        if (selector === "title") continue;
        const nodes = typeof documentObject.querySelectorAll === "function"
          ? documentObject.querySelectorAll(selector)
          : [documentObject.querySelector(selector)].filter(Boolean);
        for (const node of nodes) {
          if (!originalText.has(node)) originalText.set(node, node.textContent);
          node.textContent = locale === "zh-CN" ? text : originalText.get(node);
        }
      }
      return locale;
    };
  }

  // Looks up an English source string, then fills {name} placeholders in either language.
  function createTranslator(messages) {
    return function translate(message, choice, systemLocale = "en", vars = null) {
      if (typeof message !== "string") return "";
      const localized = resolveLocale(choice, systemLocale) === "zh-CN"
        && Object.prototype.hasOwnProperty.call(messages, message)
        ? messages[message]
        : message;
      return fill(localized, vars);
    };
  }

  // Chinese sentences join without spaces; English sentences join with one.
  function joinSentences(parts, choice, systemLocale = "en") {
    const separator = resolveLocale(choice, systemLocale) === "zh-CN" ? "" : " ";
    return parts.filter(Boolean).join(separator);
  }

  const api = Object.freeze({
    LOCALES,
    createStaticApplier,
    createTranslator,
    fill,
    joinSentences,
    resolveLocale,
  });
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (globalObject) globalObject.meetingWikiI18n = api;
})(typeof window === "undefined" ? null : window);
