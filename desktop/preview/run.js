"use strict";

// Renders every UI page with fake data and saves light and dark screenshots.
// Usage: npx electron preview/run.js [output dir]

const { app, BrowserWindow, nativeTheme } = require("electron");
const fs = require("fs");
const path = require("path");

const RENDERER = path.join(__dirname, "..", "renderer");
const OUT = path.resolve(process.argv.find((value, index) => index > 1 && !value.startsWith("-") && !value.endsWith("run.js")) || path.join(__dirname, "..", "dist", "ui-preview"));

// Each shot: page, stub set, window size, and optional script run before capture.
const SHOTS = [
  { name: "wiki-recent", file: "index.html", stub: "wiki", width: 1120, height: 780 },
  { name: "wiki-decisions", file: "index.html", stub: "wiki", width: 1120, height: 780, script: 'document.querySelector("[data-view=decisions]").click()' },
  { name: "wiki-actions", file: "index.html", stub: "wiki", width: 1120, height: 780, script: 'document.querySelector("[data-view=actions]").click()' },
  { name: "wiki-recovery", file: "index.html", stub: "wiki", width: 1120, height: 780, script: 'document.querySelector("[data-view=recovery]").click()' },
  { name: "setup", file: "setup.html", stub: "setup", width: 980, height: 760 },
  { name: "settings", file: "settings.html", stub: "settings", width: 720, height: 760 },
  { name: "record", file: "record.html", stub: "record", width: 560, height: 680 },
  { name: "live-sidebar", file: "live-sidebar.html", stub: "live", width: 380, height: 640 },
];

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function capture(shot, theme) {
  console.log(`capturing ${shot.name} (${theme})`);
  nativeTheme.themeSource = theme;
  const window = new BrowserWindow({
    width: shot.width,
    height: shot.height,
    show: false,
    paintWhenInitiallyHidden: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      additionalArguments: [`--mw-preview=${shot.stub}`],
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  try {
    await window.loadFile(path.join(RENDERER, shot.file));
  } catch (_) {
    // A rapid reopen can report ERR_FAILED once; load again and wait for the document.
    await wait(300);
    await window.loadFile(path.join(RENDERER, shot.file));
  }
  await wait(400);
  if (shot.script) {
    await window.webContents.executeJavaScript(shot.script);
    await wait(400);
  }
  const image = await window.webContents.capturePage();
  fs.writeFileSync(path.join(OUT, `${shot.name}-${theme}.png`), image.toPNG());
  window.destroy();
}

// Windows are opened and closed one at a time; the app must not quit in between.
app.on("window-all-closed", () => {});

app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  try {
    for (const shot of SHOTS) {
      for (const theme of ["light", "dark"]) await capture(shot, theme);
    }
    console.log(`Saved ${SHOTS.length * 2} screenshots to ${OUT}`);
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
  app.quit();
});
