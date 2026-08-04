import type { DayPoint } from './types';

type Rgb = readonly [number, number, number];

// ダッシュボードのライトテーマ配色に合わせる
const BG: Rgb = [255, 255, 255]; // --surface
const FRAME: Rgb = [226, 232, 240]; // --border #e2e8f0
const GRID: Rgb = [237, 241, 246]; // 枠より薄いグリッド線
const WEIGHT: Rgb = [2, 132, 199]; // --accent #0284c7
const FAT: Rgb = [217, 119, 6]; // --accent-2 #d97706
const FFM: Rgb = [5, 150, 105]; // --accent-3 #059669

const PADDING = 80;
const LINE_THICKNESS = 3;
const DOT_THICKNESS = 9;

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

function drawLine(c: Canvas, x0: number, y0: number, x1: number, y1: number, rgb: Rgb, thickness: number): void {
  const dx = Math.abs(x1 - x0);
  const sx = x0 < x1 ? 1 : -1;
  const dy = -Math.abs(y1 - y0);
  const sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  let x = x0;
  let y = y0;
  for (;;) {
    stamp(c, x, y, rgb, thickness);
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

/** min/max±10%マージンの値→Y座標変換を作る（値が無ければnull） */
function makeYScale(values: number[], top: number, bottom: number): ((v: number) => number) | null {
  if (values.length === 0) return null;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const lo = min - span * 0.1;
  const hi = max + span * 0.1;
  return (v: number): number => Math.round(bottom - ((bottom - top) * (v - lo)) / (hi - lo));
}

/** 実測系列: 線（2点以上）+ 全点にドット */
function drawSeries(
  c: Canvas,
  points: SeriesPoint[],
  xOf: (index: number) => number,
  yOf: ((v: number) => number) | null,
  rgb: Rgb,
): void {
  if (!yOf || points.length === 0) return;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    drawLine(c, xOf(a.index), yOf(a.value), xOf(b.index), yOf(b.value), rgb, LINE_THICKNESS);
  }
  for (const p of points) {
    stamp(c, xOf(p.index), yOf(p.value), rgb, DOT_THICKNESS);
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

/**
 * ダッシュボードの1M実測表示に相当するグラフをライトテーマで描く。
 * 体重・除脂肪体重はkgスケールを共有し、体脂肪率は独自スケール（2軸相当）。
 */
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

  drawFrame(c, left, top, right, bottom, FRAME);

  const weightPoints = collectSeries(days, (d) => d.weight);
  const fatPoints = collectSeries(days, (d) => d.fat_ratio);
  const ffmPoints = collectSeries(days, (d) => d.fat_free_mass);
  if (weightPoints.length + fatPoints.length + ffmPoints.length === 0) {
    return encodePng(c);
  }

  // 内側の水平グリッド線（4分割）
  for (let i = 1; i <= 3; i++) {
    drawHorizontal(c, left + 1, right - 1, Math.round(top + ((bottom - top) * i) / 4), GRID);
  }

  // X座標は配列インデックスではなく日付に比例させる（欠測日があると等間隔では日付位置がずれる）。
  // データが1日分だけの場合は「直近」を示す右端に置く
  const times = days.map((d) => Date.parse(`${d.d}T00:00:00Z`));
  const t0 = Math.min(...times);
  const t1 = Math.max(...times);
  const xOf = (index: number): number =>
    t1 === t0 ? right : Math.round(left + ((right - left) * (times[index] - t0)) / (t1 - t0));

  const kgScale = makeYScale(
    [...weightPoints, ...ffmPoints].map((p) => p.value),
    top,
    bottom,
  );
  const pctScale = makeYScale(
    fatPoints.map((p) => p.value),
    top,
    bottom,
  );

  drawSeries(c, ffmPoints, xOf, kgScale, FFM);
  drawSeries(c, fatPoints, xOf, pctScale, FAT);
  // 体重を最前面に描く
  drawSeries(c, weightPoints, xOf, kgScale, WEIGHT);

  return encodePng(c);
}
