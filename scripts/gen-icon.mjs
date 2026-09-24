// app/scripts/gen-icon.mjs — 基于 DSH 官方鲸鱼 LOGO 生成应用图标。
// 组合：暖纸圆角方底 + 官方鲸鱼（.tmp/official-icon.png，双线性放大）。
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const SIZE = 1024;
const px = new Uint8Array(SIZE * SIZE * 4);



function put(x, y, r, g, b, a) {
  if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) return;
  const i = (y * SIZE + x) * 4;
  const sa = a / 255;
  const da = px[i + 3] / 255;
  const na = sa + da * (1 - sa);
  if (na <= 0) return;
  px[i] = Math.round((r * sa + px[i] * da * (1 - sa)) / na);
  px[i + 1] = Math.round((g * sa + px[i + 1] * da * (1 - sa)) / na);
  px[i + 2] = Math.round((b * sa + px[i + 2] * da * (1 - sa)) / na);
  px[i + 3] = Math.round(na * 255);
}

function decodePng(file) {
  const buf = fs.readFileSync(file);
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error("not png");
  let pos = 8;
  let w = 0, h = 0, colorType = 6;
  const idats = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString("ascii", pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") {
      w = data.readUInt32BE(0);
      h = data.readUInt32BE(4);
      colorType = data[9];
    } else if (type === "IDAT") {
      idats.push(data);
    } else if (type === "IEND") break;
    pos += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idats));
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 4;
  const stride = w * channels;
  const img = Buffer.alloc(w * h * 4);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const filter = raw[y * (stride + 1)];
    const cur = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? cur[x - channels] : 0;
      const bb = prev[x];
      const c = x >= channels ? prev[x - channels] : 0;
      switch (filter) {
        case 1: cur[x] = (cur[x] + a) & 0xff; break;
        case 2: cur[x] = (cur[x] + bb) & 0xff; break;
        case 3: cur[x] = (cur[x] + ((a + bb) >> 1)) & 0xff; break;
        case 4: {
          const p = a + bb - c, pa = Math.abs(p - a), pb = Math.abs(p - bb), pc = Math.abs(p - c);
          const pr = pa <= pb && pa <= pc ? a : pb <= pc ? bb : c;
          cur[x] = (cur[x] + pr) & 0xff;
          break;
        }
      }
    }
    prev = cur;
    for (let x = 0; x < w; x++) {
      const si = x * channels;
      const di = (y * w + x) * 4;
      img[di] = cur[si];
      img[di + 1] = channels >= 3 ? cur[si + 1] : cur[si];
      img[di + 2] = channels >= 3 ? cur[si + 2] : cur[si];
      img[di + 3] = channels === 4 ? cur[si + 3] : 255;
    }
  }
  return { width: w, height: h, data: img };
}

function rr(x0, y0, x1, y1, radius, col) {
  for (let y = Math.floor(y0); y < y1; y++) {
    for (let x = Math.floor(x0); x < x1; x++) {
      const dx = x < x0 + radius ? x0 + radius - x : x > x1 - radius ? x - (x1 - radius) : 0;
      const dy = y < y0 + radius ? y0 + radius - y : y > y1 - radius ? y - (y1 - radius) : 0;
      if (dx > 0 && dy > 0 && dx * dx + dy * dy > radius * radius) continue;
      put(x, y, col[0], col[1], col[2], 255);
    }
  }
}
rr(0, 0, SIZE, SIZE, 200, [247, 244, 238]);

const src = decodePng(path.resolve("..", ".tmp", "official-icon.png"));
const target = 660;
const scaleX = src.width / target;
const scaleY = src.height / target;
const offX = Math.floor((SIZE - target) / 2);
const offY = Math.floor((SIZE - target) / 2) - 8;
const sample = (sx, sy) => {
  const x0 = Math.floor(sx), y0 = Math.floor(sy);
  const fx = sx - x0, fy = sy - y0;
  const get = (x, y, ch) => {
    x = Math.max(0, Math.min(src.width - 1, x));
    y = Math.max(0, Math.min(src.height - 1, y));
    return src.data[(y * src.width + x) * 4 + ch];
  };
  const out = [0, 0, 0, 0];
  for (let ch = 0; ch < 4; ch++) {
    out[ch] =
      get(x0, y0, ch) * (1 - fx) * (1 - fy) +
      get(x0 + 1, y0, ch) * fx * (1 - fy) +
      get(x0, y0 + 1, ch) * (1 - fx) * fy +
      get(x0 + 1, y0 + 1, ch) * fx * fy;
  }
  return out;
};
for (let y = 0; y < target; y++) {
  for (let x = 0; x < target; x++) {
    const s = sample(x * scaleX, y * scaleY);
    const alpha = s[3] / 255;
    if (alpha < 0.01) continue;
    put(offX + x, offY + y, 16, 16, 16, alpha * 255);
  }
}

function crc32(buf) {
  let c;
  const table = [];
  for (let n = 0; n < 256; n++) {
    c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8;
ihdr[9] = 6;
const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0;
  Buffer.from(px.buffer, y * SIZE * 4, SIZE * 4).copy(raw, y * (SIZE * 4 + 1) + 1);
}
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);
const out = process.argv[2] || path.join("src-tauri", "icons", "icon-1024.png");
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, png);
console.log("icon written:", out, (png.length / 1024).toFixed(1) + "KB");
