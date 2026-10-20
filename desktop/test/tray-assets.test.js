"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const DESKTOP = path.join(__dirname, "..");
const main = fs.readFileSync(path.join(DESKTOP, "main.js"), "utf8");
const pkg = require("../package.json");

test("tray status icons are bundled PNG template assets", () => {
  for (const state of ["idle", "recording", "processing", "attention"]) {
    const asset = `assets/tray-${state}@2x.png`;
    assert.ok(fs.existsSync(path.join(DESKTOP, asset)), `missing ${asset}`);
    assert.ok(pkg.build.files.includes(asset), `package is missing ${asset}`);
  }
  assert.match(main, /nativeImage\.createFromPath/);
  assert.doesNotMatch(main, /nativeImage\.createFromDataURL/);
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

test("recording tray PNG is a monochrome record mark distinct from idle", () => {
  const pixels = decodePng(path.join(DESKTOP, "assets", "tray-recording@2x.png"));
  assert.equal(pixels.length, 36);
  assert.equal(pixels[0].length, 36);
  for (const row of pixels) {
    for (const [r, g, b, a] of row) {
      if (a > 0) assert.deepEqual([r, g, b], [0, 0, 0], "template icons use black only");
    }
  }
  const alpha = (x, y) => pixels[y][x][3];
  assert.equal(alpha(18, 18), 255, "solid center dot");
  assert.equal(alpha(29, 18), 0, "transparent gap between dot and ring");
  assert.equal(alpha(18, 7), 0, "transparent gap above the dot");
  assert.equal(alpha(32, 18), 255, "outer ring right");
  assert.equal(alpha(18, 3), 255, "outer ring top");
  assert.equal(alpha(0, 0), 0, "transparent corner");

  const idle = fs.readFileSync(path.join(DESKTOP, "assets", "tray-idle@2x.png"));
  assert.notDeepEqual(fs.readFileSync(path.join(DESKTOP, "assets", "tray-recording@2x.png")), idle);
  const svg = fs.readFileSync(path.join(DESKTOP, "assets", "tray-recording.svg"), "utf8");
  assert.match(svg, /<circle cx="9" cy="9" r="7\.25" fill="none" stroke="#000000"/);
  assert.match(svg, /<circle cx="9" cy="9" r="4\.25" fill="#000000"\/>/);
  assert.doesNotMatch(svg, /#FFFFFF/i);
});
