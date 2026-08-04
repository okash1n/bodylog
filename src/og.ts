import type { DayPoint } from './types';

type Rgb = readonly [number, number, number];

const BG: Rgb = [15, 23, 42]; // #0f172a
const WEIGHT: Rgb = [56, 189, 248]; // #38bdf8
const AVG: Rgb = [148, 163, 184]; // #94a3b8
const GUIDE: Rgb = [51, 65, 85]; // #334155

const PADDING = 80;
const WEIGHT_THICKNESS = 4;
const AVG_THICKNESS = 2;
// 破線様: Bresenhamステップ数で on/off を刻む
const DASH_ON = 6;
const DASH_OFF = 4;

const PNG_SIGNATURE = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);

let crcTable: Uint32Array | null = null;

function getCrcTable(): Uint32Array {
  if (crcTable) return crcTable;
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  crcTable = table;
  return table;
}

function crc32(bytes: Uint8Array): number {
  const table = getCrcTable();
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    c = table[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

/** length + type + data + CRC32(type + data) */
function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** CompressionStream('deflate') はzlib形式なのでそのままIDATに使える */
async function zlibDeflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

interface Canvas {
  width: number;
  height: number;
  px: Uint8Array; // RGBA
}

function setPixel(c: Canvas, x: number, y: number, rgb: Rgb): void {
  if (x < 0 || y < 0 || x >= c.width || y >= c.height) return;
  const i = (y * c.width + x) * 4;
  c.px[i] = rgb[0];
  c.px[i + 1] = rgb[1];
  c.px[i + 2] = rgb[2];
  c.px[i + 3] = 255;
}

/** 太さは正方形スタンプで表現する */
function stamp(c: Canvas, x: number, y: number, rgb: Rgb, thickness: number): void {
  const start = -(thickness >> 1);
  for (let dy = 0; dy < thickness; dy++) {
    for (let dx = 0; dx < thickness; dx++) {
      setPixel(c, x + start + dx, y + start + dy, rgb);
    }
  }
}

interface DashState {
  step: number;
}

function drawLine(
  c: Canvas,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  rgb: Rgb,
  thickness: number,
  dash?: DashState,
): void {
  const dx = Math.abs(x1 - x0);
  const sx = x0 < x1 ? 1 : -1;
  const dy = -Math.abs(y1 - y0);
  const sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  let x = x0;
  let y = y0;
  for (;;) {
    const on = !dash || dash.step % (DASH_ON + DASH_OFF) < DASH_ON;
    if (on) stamp(c, x, y, rgb, thickness);
    if (dash) dash.step++;
    if (x === x1 && y === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      x += sx;
    }
    if (e2 <= dx) {
      err += dx;
      y += sy;
    }
  }
}

function drawHorizontal(c: Canvas, x0: number, x1: number, y: number, rgb: Rgb): void {
  for (let x = x0; x <= x1; x++) setPixel(c, x, y, rgb);
}

function drawFrame(c: Canvas, left: number, top: number, right: number, bottom: number, rgb: Rgb): void {
  for (let x = left; x <= right; x++) {
    setPixel(c, x, top, rgb);
    setPixel(c, x, bottom, rgb);
  }
  for (let y = top; y <= bottom; y++) {
    setPixel(c, left, y, rgb);
    setPixel(c, right, y, rgb);
  }
}

interface SeriesPoint {
  index: number;
  value: number;
}

function collectSeries(days: DayPoint[], pick: (d: DayPoint) => number | null): SeriesPoint[] {
  const points: SeriesPoint[] = [];
  for (let i = 0; i < days.length; i++) {
    const v = pick(days[i]);
    if (v !== null && Number.isFinite(v)) points.push({ index: i, value: v });
  }
  return points;
}

function drawPolyline(
  c: Canvas,
  points: SeriesPoint[],
  xOf: (index: number) => number,
  yOf: (value: number) => number,
  rgb: Rgb,
  thickness: number,
  dashed: boolean,
): void {
  const dash: DashState | undefined = dashed ? { step: 0 } : undefined;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    drawLine(c, xOf(a.index), yOf(a.value), xOf(b.index), yOf(b.value), rgb, thickness, dash);
  }
}

async function encodePng(c: Canvas): Promise<Uint8Array> {
  const rowBytes = 1 + c.width * 4; // 行頭にfilter byte 0
  const raw = new Uint8Array(c.height * rowBytes);
  for (let y = 0; y < c.height; y++) {
    raw.set(c.px.subarray(y * c.width * 4, (y + 1) * c.width * 4), y * rowBytes + 1);
  }
  const idat = await zlibDeflate(raw);

  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, c.width);
  view.setUint32(4, c.height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  // compression(0) / filter(0) / interlace(0)

  const chunks = [PNG_SIGNATURE, pngChunk('IHDR', ihdr), pngChunk('IDAT', idat), pngChunk('IEND', new Uint8Array(0))];
  const total = chunks.reduce((n, ch) => n + ch.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const ch of chunks) {
    out.set(ch, offset);
    offset += ch.length;
  }
  return out;
}

export async function renderOgPng(days: DayPoint[], opts: { width: number; height: number }): Promise<Uint8Array> {
  const { width, height } = opts;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new Error(`renderOgPng: invalid size ${width}x${height}`);
  }

  const c: Canvas = { width, height, px: new Uint8Array(width * height * 4) };
  for (let i = 0; i < c.px.length; i += 4) {
    c.px[i] = BG[0];
    c.px[i + 1] = BG[1];
    c.px[i + 2] = BG[2];
    c.px[i + 3] = 255;
  }

  // パディングは小サイズでも描画領域が1px以上残るようclamp
  const pad = Math.max(0, Math.min(PADDING, Math.floor((Math.min(width, height) - 1) / 2)));
  const left = pad;
  const right = width - 1 - pad;
  const top = pad;
  const bottom = height - 1 - pad;

  drawFrame(c, left, top, right, bottom, GUIDE);

  const weightPoints = collectSeries(days, (d) => d.weight);
  if (weightPoints.length < 2) {
    return encodePng(c);
  }

  const avgPoints = collectSeries(days, (d) => d.weight_7d_avg);
  const values = [...weightPoints, ...avgPoints].map((p) => p.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  // 表示レンジは±10%マージン（min/maxガイドを枠から離す）
  const lo = min - span * 0.1;
  const hi = max + span * 0.1;

  const lastIndex = days.length - 1 || 1;
  const xOf = (index: number): number => Math.round(left + ((right - left) * index) / lastIndex);
  const yOf = (value: number): number => Math.round(bottom - ((bottom - top) * (value - lo)) / (hi - lo));

  drawHorizontal(c, left, right, yOf(max), GUIDE);
  drawHorizontal(c, left, right, yOf(min), GUIDE);

  drawPolyline(c, avgPoints, xOf, yOf, AVG, AVG_THICKNESS, true);
  drawPolyline(c, weightPoints, xOf, yOf, WEIGHT, WEIGHT_THICKNESS, false);

  return encodePng(c);
}
