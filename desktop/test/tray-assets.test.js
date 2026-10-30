"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const DESKTOP = path.join(__dirname, "..");
const main = fs.readFileSync(path.join(DESKTOP, "main.js"), "utf8");
const pkg = require("../package.json");

test("the tray uses one bundled PNG template icon", () => {
  const asset = "assets/tray-idle@2x.png";
  assert.ok(fs.existsSync(path.join(DESKTOP, asset)), `missing ${asset}`);
  assert.deepEqual(pkg.build.files.filter((entry) => entry.startsWith("assets/tray-")), [asset]);
  assert.match(main, /nativeImage\.createFromPath\(TRAY_ICON_PATH\)/);
  assert.doesNotMatch(main, /nativeImage\.createFromDataURL|tray\.setImage/);
});

// Decodes an 8-bit RGBA, non-interlaced PNG into rows of [r, g, b, a] pixels.
function decodePng(file) {
  const zlib = require("zlib");
  const data = fs.readFileSync(file);
  assert.equal(data.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  let offset = 8;
  let width;
  let height;
  const idat = [];
  while (offset < data.length) {
    const length = data.readUInt32BE(offset);
    const type = data.toString("ascii", offset + 4, offset + 8);
    const body = data.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      assert.deepEqual([body[8], body[9], body[12]], [8, 6, 0], "expected 8-bit RGBA non-interlaced");
    } else if (type === "IDAT") {
      idat.push(body);
    }
    offset += 12 + length;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * 4;
  const out = [];
  let previous = Buffer.alloc(stride);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const line = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    for (let x = 0; x < stride; x += 1) {
      const left = x >= 4 ? line[x - 4] : 0;
      const up = previous[x];
      const upLeft = x >= 4 ? previous[x - 4] : 0;
      let add = 0;
      if (filter === 1) add = left;
      else if (filter === 2) add = up;
      else if (filter === 3) add = (left + up) >> 1;
      else if (filter === 4) {
        const estimate = left + up - upLeft;
        const [pa, pb, pc] = [Math.abs(estimate - left), Math.abs(estimate - up), Math.abs(estimate - upLeft)];
        add = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
      }
      line[x] = (line[x] + add) & 0xff;
    }
    const row = [];
    for (let x = 0; x < width; x += 1) row.push([...line.subarray(x * 4, x * 4 + 4)]);
    out.push(row);
    previous = line;
  }
  return out;
}

test("tray PNG is a black-only L mark with a dot inside its corner", () => {
  const pixels = decodePng(path.join(DESKTOP, "assets", "tray-idle@2x.png"));
  assert.equal(pixels.length, 36);
  assert.equal(pixels[0].length, 36);
  for (const row of pixels) {
    for (const [r, g, b, a] of row) {
      if (a > 0) assert.deepEqual([r, g, b], [0, 0, 0], "template icons use black only");
    }
  }
  const alpha = (x, y) => pixels[y][x][3];
  assert.equal(alpha(9, 16), 255, "vertical stem");
  assert.equal(alpha(20, 29), 255, "horizontal foot");
  assert.equal(alpha(22, 16), 255, "dot");
  assert.equal(alpha(14, 22), 0, "gap between the stem and the dot");
  assert.equal(alpha(22, 24), 0, "gap between the dot and the foot");
  assert.equal(alpha(34, 2), 0, "open top right corner");
  const svg = fs.readFileSync(path.join(DESKTOP, "assets", "tray-idle.svg"), "utf8");
  assert.doesNotMatch(svg, /#FFFFFF/i);
});

test("the app icon source is the L mark and the icns holds every macOS size", () => {
  const svg = fs.readFileSync(path.join(DESKTOP, "assets", "app-icon.svg"), "utf8");
  assert.match(svg, /<path d="M360 300 V700 H720"/);
  assert.equal(pkg.build.mac.icon, "assets/icon.icns");
  const icns = fs.readFileSync(path.join(DESKTOP, "assets", "icon.icns"));
  assert.equal(icns.toString("ascii", 0, 4), "icns");
  const types = new Set();
  for (let offset = 8; offset < icns.length; offset += icns.readUInt32BE(offset + 4)) {
    types.add(icns.toString("ascii", offset, offset + 4));
  }
  for (const type of ["ic04", "ic05", "ic07", "ic08", "ic09", "ic10", "ic11", "ic12", "ic13", "ic14"]) {
    assert.ok(types.has(type), `icns is missing ${type}`);
  }
});
