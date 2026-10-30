"use strict";

// Matches --bg in renderer/theme.css so a window paints the page color before CSS loads.
const WINDOW_BACKGROUND = Object.freeze({ light: "#f4efe6", dark: "#1b1815" });

function windowBackground(nativeTheme = electronNativeTheme()) {
  return nativeTheme && nativeTheme.shouldUseDarkColors ? WINDOW_BACKGROUND.dark : WINDOW_BACKGROUND.light;
}

// Outside Electron (unit tests), require("electron") is a path string with no nativeTheme.
function electronNativeTheme() {
  try {
    return require("electron").nativeTheme || null;
  } catch (_) {
    return null;
  }
}

module.exports = { WINDOW_BACKGROUND, windowBackground };
