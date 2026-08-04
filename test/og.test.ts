import { describe, expect, it } from 'vitest';
import type { DayPoint } from '../src/types';
import { renderOgPng } from '../src/og';

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(...parts: Uint8Array[]): number {
  let c = 0xffffffff;
  for (const part of parts) {
    for (let i = 0; i < part.length; i++) c = CRC_TABLE[(c ^ part[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function u32(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
}

interface PngChunk {
  type: string;
  typeBytes: Uint8Array;
  data: Uint8Array;
  crc: number;
}

function parsePng(bytes: Uint8Array): PngChunk[] {
  expect(Array.from(bytes.slice(0, 8))).toEqual(PNG_SIGNATURE);
  const chunks: PngChunk[] = [];
  let offset = 8;
  while (offset < bytes.length) {
    const length = u32(bytes, offset);
    const typeBytes = bytes.slice(offset + 4, offset + 8);
    const type = String.fromCharCode(...typeBytes);
    const data = bytes.slice(offset + 8, offset + 8 + length);
    const crc = u32(bytes, offset + 8 + length);
    chunks.push({ type, typeBytes, data, crc });
    offset += 12 + length;
  }
  expect(offset).toBe(bytes.length); // チャンク境界がファイル末尾と一致
  return chunks;
}

async function inflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function mkDays(n: number): DayPoint[] {
  return Array.from({ length: n }, (_, i) => ({
    d: new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10),
    // null 日はスキップされる仕様なので混ぜておく
    weight: i === 3 ? null : 65 + Math.sin(i / 3),
    fat_ratio: null,
    fat_free_mass: null,
    weight_7d_avg: i === 3 ? null : 65,
    fat_ratio_7d_avg: null,
    fat_free_mass_7d_avg: null,
  }));
}

describe('renderOgPng', () => {
  it('PNGシグネチャ・IHDR(1200x630, 8bit RGBA)・チャンクCRCが正しい', async () => {
    const png = await renderOgPng(mkDays(30), { width: 1200, height: 630 });
    const chunks = parsePng(png);

    expect(chunks[0].type).toBe('IHDR');
    expect(chunks[chunks.length - 1].type).toBe('IEND');
    expect(chunks.some((c) => c.type === 'IDAT')).toBe(true);

    const ihdr = chunks[0].data;
    expect(ihdr.length).toBe(13);
    expect(u32(ihdr, 0)).toBe(1200); // width
    expect(u32(ihdr, 4)).toBe(630); // height
    expect(ihdr[8]).toBe(8); // bit depth
    expect(ihdr[9]).toBe(6); // color type RGBA

    for (const chunk of chunks) {
      expect(chunk.crc).toBe(crc32(chunk.typeBytes, chunk.data));
    }
  });

  it('データ2点未満（0件）でも正しいPNGを返す', async () => {
    const png = await renderOgPng([], { width: 1200, height: 630 });
    const chunks = parsePng(png);
    expect(u32(chunks[0].data, 0)).toBe(1200);
    expect(u32(chunks[0].data, 4)).toBe(630);
    for (const chunk of chunks) {
      expect(chunk.crc).toBe(crc32(chunk.typeBytes, chunk.data));
    }
  });

  it('IDATはzlib deflateで、展開すると (1+width*4)*height バイトになる', async () => {
    const width = 100;
    const height = 50;
    const png = await renderOgPng(mkDays(10), { width, height });
    const chunks = parsePng(png);

    const idatChunks = chunks.filter((c) => c.type === 'IDAT');
    const total = idatChunks.reduce((sum, c) => sum + c.data.length, 0);
    const idat = new Uint8Array(total);
    let offset = 0;
    for (const c of idatChunks) {
      idat.set(c.data, offset);
      offset += c.data.length;
    }

    const raw = await inflate(idat);
    expect(raw.length).toBe((1 + width * 4) * height);
    // 各行の先頭は filter byte 0
    for (let y = 0; y < height; y++) {
      expect(raw[y * (1 + width * 4)]).toBe(0);
    }
  });
});
