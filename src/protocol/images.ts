/**
 * Zero-dependency inline image fitting.
 *
 * `agy` accepts inline images from a tool result, but the upstream models refuse
 * (or silently drop) an image whose side is very large or whose base64 payload is
 * huge. Magpie's own Claude bridge solves this in `internal/gateway/claude_images.go`
 * by re-encoding an oversized image the way Claude Code itself would: scaled to fit
 * `2000` px a side, JPEG written again as JPEG at quality 85, any other format as
 * PNG, then as JPEG at a lower quality if that still exceeds `5 MiB` of base64.
 *
 * This module is the same policy without a dependency: small PNG/JPEG/GIF/WebP
 * decoders (enough to get RGBA pixels out of anything a tool result can carry),
 * an area-average downscaler, and PNG/baseline-JPEG encoders. Animated WebP and
 * any unreadable or malformed input are passed through untouched rather than
 * corrupted.
 *
 * The image that already fits is never touched, byte for byte, and an image this
 * module cannot read is likewise returned exactly as it arrived: a wrong re-encode
 * would be worse than a large one.
 *
 * Everything here is synchronous. Decoding is bounded by `MAX_DECODE_HOLD_BYTES`
 * (a raw size plus an RGBA estimate) so a decompression bomb cannot exhaust the
 * plugin host, and results are memoized so a repeated image costs one hash.
 */

import { createHash } from "node:crypto";
import { deflateSync, inflateSync } from "node:zlib";
import type { NormalizedContentPart } from "../types";
import { decodeWebp } from "./webp";

export type ImageMediaType = Extract<
  NormalizedContentPart,
  { type: "image" }
>["mediaType"];

/** Longest side an inline image is allowed to have before it is scaled down. */
export const MAX_INLINE_IMAGE_SIDE = 2000;

/** Largest base64 payload (characters) handed upstream in one image block. */
export const MAX_INLINE_IMAGE_BASE64_BYTES = 5 * 1024 * 1024;

/**
 * Upper bound on the memory a single decode may commit: the encoded bytes plus an
 * RGBA8 estimate of the decoded pixels. A larger image is passed through untouched
 * instead of risking an out-of-memory kill of the whole plugin host.
 */
export const MAX_DECODE_HOLD_BYTES = 256 * 1024 * 1024;

const FITTED_CACHE_MAX_ENTRIES = 32;
const FITTED_CACHE_MAX_BYTES = 32 * 1024 * 1024;

export interface RgbaImage {
  width: number;
  height: number;
  /** Row-major RGBA8, `width * height * 4` bytes. */
  rgba: Uint8Array;
}

export interface ImageDimensions {
  width: number;
  height: number;
  format: "png" | "jpeg" | "gif" | "webp";
}

// ---------------------------------------------------------------------------
// Byte helpers
// ---------------------------------------------------------------------------

function readU16BE(buf: Uint8Array, off: number): number {
  return ((buf[off]! << 8) | buf[off + 1]!) & 0xffff;
}

function readU32BE(buf: Uint8Array, off: number): number {
  return (
    ((buf[off]! << 24) | (buf[off + 1]! << 16) | (buf[off + 2]! << 8) | buf[off + 3]!) >>>
    0
  );
}

function readU32LE(buf: Uint8Array, off: number): number {
  return (
    (buf[off]! | (buf[off + 1]! << 8) | (buf[off + 2]! << 16) | (buf[off + 3]! << 24)) >>>
    0
  );
}

function readU16LE(buf: Uint8Array, off: number): number {
  return (buf[off]! | (buf[off + 1]! << 8)) & 0xffff;
}

function readU24LE(buf: Uint8Array, off: number): number {
  return (buf[off]! | (buf[off + 1]! << 8) | (buf[off + 2]! << 16)) & 0xffffff;
}

function matchesAscii(buf: Uint8Array, off: number, text: string): boolean {
  if (off + text.length > buf.length) return false;
  for (let i = 0; i < text.length; i += 1) {
    if (buf[off + i] !== text.charCodeAt(i)) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Dimension probing
// ---------------------------------------------------------------------------

/**
 * Reads the pixel dimensions of a PNG, JPEG, GIF or WebP without decoding it.
 * `null` means "not an image this module understands".
 */
export function readImageDimensions(raw: Uint8Array): ImageDimensions | null {
  if (raw.length >= 24 && isPngHeader(raw)) {
    // IHDR must be the first chunk: signature (8) + length (4) + type (4).
    if (!matchesAscii(raw, 12, "IHDR")) return null;
    const width = readU32BE(raw, 16);
    const height = readU32BE(raw, 20);
    if (width <= 0 || height <= 0) return null;
    return { width, height, format: "png" };
  }

  if (raw.length >= 4 && raw[0] === 0xff && raw[1] === 0xd8) {
    return readJpegDimensions(raw);
  }

  if (
    raw.length >= 10 &&
    matchesAscii(raw, 0, "GIF8") &&
    (raw[4] === 0x37 || raw[4] === 0x39) &&
    raw[5] === 0x61
  ) {
    const width = readU16LE(raw, 6);
    const height = readU16LE(raw, 8);
    if (width <= 0 || height <= 0) return null;
    return { width, height, format: "gif" };
  }

  if (raw.length >= 30 && matchesAscii(raw, 0, "RIFF") && matchesAscii(raw, 8, "WEBP")) {
    return readWebpDimensions(raw);
  }

  return null;
}

function isPngHeader(raw: Uint8Array): boolean {
  return (
    raw[0] === 0x89 &&
    raw[1] === 0x50 &&
    raw[2] === 0x4e &&
    raw[3] === 0x47 &&
    raw[4] === 0x0d &&
    raw[5] === 0x0a &&
    raw[6] === 0x1a &&
    raw[7] === 0x0a
  );
}

/** True for a frame header (`SOF`) marker, excluding `DHT`, `JPG` and `DAC`. */
function isSofMarker(marker: number): boolean {
  if (marker < 0xc0 || marker > 0xcf) return false;
  return marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
}

function readJpegDimensions(raw: Uint8Array): ImageDimensions | null {
  let off = 2;
  while (off + 3 < raw.length) {
    if (raw[off] !== 0xff) {
      off += 1;
      continue;
    }
    const marker = raw[off + 1]!;
    if (marker === 0xff) {
      // Fill byte: the real marker follows.
      off += 1;
      continue;
    }
    off += 2;
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      // Standalone markers carry no length.
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return null;
    if (off + 1 >= raw.length) return null;
    const length = readU16BE(raw, off);
    if (length < 2) return null;
    if (isSofMarker(marker)) {
      if (off + 7 > raw.length) return null;
      const height = readU16BE(raw, off + 3);
      const width = readU16BE(raw, off + 5);
      if (width <= 0 || height <= 0) return null;
      return { width, height, format: "jpeg" };
    }
    off += length;
  }
  return null;
}

function readWebpDimensions(raw: Uint8Array): ImageDimensions | null {
  if (matchesAscii(raw, 12, "VP8 ")) {
    if (raw.length < 30) return null;
    if (raw[23] !== 0x9d || raw[24] !== 0x01 || raw[25] !== 0x2a) return null;
    const width = readU16LE(raw, 26) & 0x3fff;
    const height = readU16LE(raw, 28) & 0x3fff;
    if (width <= 0 || height <= 0) return null;
    return { width, height, format: "webp" };
  }
  if (matchesAscii(raw, 12, "VP8L")) {
    if (raw.length < 25 || raw[20] !== 0x2f) return null;
    const bits = readU32LE(raw, 21);
    // VP8L packs (width-1) and (height-1) as little-endian 14-bit fields.
    const width = ((bits & 0x3fff) >>> 0) + 1;
    const height = (((bits >>> 14) & 0x3fff) >>> 0) + 1;
    return { width, height, format: "webp" };
  }
  if (matchesAscii(raw, 12, "VP8X")) {
    if (raw.length < 30) return null;
    const width = readU24LE(raw, 24) + 1;
    const height = readU24LE(raw, 27) + 1;
    return { width, height, format: "webp" };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Pixel helpers
// ---------------------------------------------------------------------------

function createRgba(width: number, height: number): Uint8Array {
  return new Uint8Array(width * height * 4);
}

function clampByte(value: number): number {
  if (value <= 0) return 0;
  if (value >= 255) return 255;
  return value | 0;
}

// ---------------------------------------------------------------------------
// PNG decoding
// ---------------------------------------------------------------------------

const PNG_CHANNELS: Readonly<Record<number, number>> = {
  0: 1,
  2: 3,
  3: 1,
  4: 2,
  6: 4,
};

/** Adam7 pass layout: x start, y start, x step, y step. */
const ADAM7_PASSES: ReadonlyArray<readonly [number, number, number, number]> = [
  [0, 0, 8, 8],
  [4, 0, 8, 8],
  [0, 4, 4, 8],
  [2, 0, 4, 4],
  [0, 2, 2, 4],
  [1, 0, 2, 2],
  [0, 1, 1, 2],
];

function paethPredictor(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/** Reverses the per-scanline filters of one (possibly interlaced) pass in place. */
function unfilterPngRows(
  data: Uint8Array,
  width: number,
  height: number,
  bitsPerPixel: number,
): void {
  const bpp = Math.max(1, Math.ceil(bitsPerPixel / 8));
  const rowBytes = Math.ceil((width * bitsPerPixel) / 8);
  let prevRowStart = -1;
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (rowBytes + 1);
    const filter = data[rowStart]!;
    const row = rowStart + 1;
    for (let i = 0; i < rowBytes; i += 1) {
      const raw = data[row + i]!;
      const left = i >= bpp ? data[row + i - bpp]! : 0;
      const up = prevRowStart >= 0 ? data[prevRowStart + i]! : 0;
      const upLeft =
        prevRowStart >= 0 && i >= bpp ? data[prevRowStart + i - bpp]! : 0;
      let value = raw;
      switch (filter) {
        case 0:
          break;
        case 1:
          value = (raw + left) & 0xff;
          break;
        case 2:
          value = (raw + up) & 0xff;
          break;
        case 3:
          value = (raw + ((left + up) >> 1)) & 0xff;
          break;
        case 4:
          value = (raw + paethPredictor(left, up, upLeft)) & 0xff;
          break;
        default:
          // Unknown filter byte: leave the scanline as it came rather than
          // producing noise.
          break;
      }
      data[row + i] = value;
    }
    prevRowStart = row;
  }
}

function readPngSample(
  data: Uint8Array,
  rowStart: number,
  sampleIndex: number,
  depth: number,
): number {
  if (depth === 8) return data[rowStart + sampleIndex]!;
  if (depth === 16) {
    const off = rowStart + sampleIndex * 2;
    return ((data[off]! << 8) | data[off + 1]!) & 0xffff;
  }
  const bit = sampleIndex * depth;
  const byte = data[rowStart + (bit >> 3)]!;
  const shift = 8 - depth - (bit & 7);
  return (byte >> shift) & ((1 << depth) - 1);
}

function scalePngSample(value: number, depth: number): number {
  switch (depth) {
    case 8:
      return value;
    case 16:
      return value >> 8;
    case 1:
      return value === 0 ? 0 : 255;
    case 2:
      return value * 85;
    case 4:
      return value * 17;
    default:
      return value;
  }
}

function decodePng(raw: Uint8Array): RgbaImage | null {
  if (!isPngHeader(raw)) return null;

  let off = 8;
  let header: Uint8Array | null = null;
  let palette: Uint8Array | null = null;
  let transparency: Uint8Array | null = null;
  const idat: Uint8Array[] = [];
  let totalIdatBytes = 0;

  while (off + 8 <= raw.length) {
    const length = readU32BE(raw, off);
    const typeStart = off + 4;
    if (typeStart + length + 4 > raw.length) return null;
    const chunk = raw.subarray(typeStart + 4, typeStart + 4 + length);
    if (matchesAscii(raw, typeStart, "IHDR")) {
      // Exactly one IHDR, and it must come first: a second one would silently
      // replace the dimensions the caller's budget was checked against.
      if (header !== null) return null;
      header = chunk;
    } else if (matchesAscii(raw, typeStart, "PLTE")) palette = chunk;
    else if (matchesAscii(raw, typeStart, "tRNS")) transparency = chunk;
    else if (matchesAscii(raw, typeStart, "IDAT")) {
      if (header === null) return null;
      totalIdatBytes += chunk.length;
      if (raw.length + totalIdatBytes > MAX_DECODE_HOLD_BYTES) return null;
      idat.push(chunk);
    } else if (matchesAscii(raw, typeStart, "IEND")) break;
    off = typeStart + 4 + length + 4;
  }

  if (header === null || header.length < 13) return null;
  if (idat.length === 0) return null;

  const width = readU32BE(header, 0);
  const height = readU32BE(header, 4);
  const depth = header[8]!;
  const colorType = header[9]!;
  const interlace = header[12]!;
  if (width <= 0 || height <= 0) return null;
  if (depth !== 1 && depth !== 2 && depth !== 4 && depth !== 8 && depth !== 16) {
    return null;
  }
  const channels = PNG_CHANNELS[colorType];
  if (channels === undefined) return null;
  if (colorType === 3 && (palette === null || palette.length < 3)) return null;

  const bitsPerPixel = channels * depth;
  const passes =
    interlace === 1
      ? ADAM7_PASSES
      : ([[0, 0, 1, 1]] as ReadonlyArray<readonly [number, number, number, number]>);

  // The inflated size is fully determined by IHDR, so it is checked *before*
  // inflation: a small IDAT can otherwise expand to gigabytes (bomb).
  let expectedInflatedBytes = 0;
  for (const [x0, y0, dx, dy] of passes) {
    const passWidth = Math.ceil((width - x0) / dx);
    const passHeight = Math.ceil((height - y0) / dy);
    if (passWidth <= 0 || passHeight <= 0) continue;
    const rowBytes = Math.ceil((passWidth * bitsPerPixel) / 8);
    expectedInflatedBytes += passHeight * (rowBytes + 1);
  }
  const rgbaBytes = width * height * 4;
  if (
    !Number.isSafeInteger(expectedInflatedBytes) ||
    expectedInflatedBytes <= 0 ||
    !Number.isSafeInteger(rgbaBytes) ||
    raw.length + totalIdatBytes + expectedInflatedBytes + rgbaBytes >
      MAX_DECODE_HOLD_BYTES
  ) {
    return null;
  }

  let inflated: Uint8Array;
  try {
    inflated = inflateSync(Buffer.concat(idat), {
      maxOutputLength: expectedInflatedBytes,
    });
  } catch {
    return null;
  }
  if (inflated.length !== expectedInflatedBytes) return null;

  const out = createRgba(width, height);

  // Transparent colour for the `tRNS` chunk of a non-palette image.
  let transparentGray = -1;
  let transparentRgb: [number, number, number] | null = null;
  if (transparency !== null && colorType === 0 && transparency.length >= 2) {
    transparentGray = readU16BE(transparency, 0);
  } else if (transparency !== null && colorType === 2 && transparency.length >= 6) {
    transparentRgb = [
      readU16BE(transparency, 0),
      readU16BE(transparency, 2),
      readU16BE(transparency, 4),
    ];
  }

  let cursor = 0;
  for (const [x0, y0, dx, dy] of passes) {
    const passWidth = Math.ceil((width - x0) / dx);
    const passHeight = Math.ceil((height - y0) / dy);
    if (passWidth <= 0 || passHeight <= 0) continue;
    const rowBytes = Math.ceil((passWidth * bitsPerPixel) / 8);
    const needed = passHeight * (rowBytes + 1);
    if (cursor + needed > inflated.length) return null;
    const passData = inflated.subarray(cursor, cursor + needed);
    cursor += needed;
    unfilterPngRows(passData, passWidth, passHeight, bitsPerPixel);

    for (let py = 0; py < passHeight; py += 1) {
      const rowStart = py * (rowBytes + 1) + 1;
      const y = y0 + py * dy;
      for (let px = 0; px < passWidth; px += 1) {
        const x = x0 + px * dx;
        const target = (y * width + x) * 4;
        const base = px * channels;
        let r = 0;
        let g = 0;
        let b = 0;
        let a = 255;
        if (colorType === 0) {
          const gray = readPngSample(passData, rowStart, base, depth);
          const value = scalePngSample(gray, depth);
          r = value;
          g = value;
          b = value;
          if (transparentGray >= 0 && gray === transparentGray) a = 0;
        } else if (colorType === 2) {
          const sr = readPngSample(passData, rowStart, base, depth);
          const sg = readPngSample(passData, rowStart, base + 1, depth);
          const sb = readPngSample(passData, rowStart, base + 2, depth);
          r = scalePngSample(sr, depth);
          g = scalePngSample(sg, depth);
          b = scalePngSample(sb, depth);
          if (
            transparentRgb !== null &&
            sr === transparentRgb[0] &&
            sg === transparentRgb[1] &&
            sb === transparentRgb[2]
          ) {
            a = 0;
          }
        } else if (colorType === 3) {
          const index = readPngSample(passData, rowStart, base, depth);
          const entry = index * 3;
          r = palette![entry] ?? 0;
          g = palette![entry + 1] ?? 0;
          b = palette![entry + 2] ?? 0;
          if (transparency !== null && index < transparency.length) {
            a = transparency[index]!;
          }
        } else if (colorType === 4) {
          const gray = readPngSample(passData, rowStart, base, depth);
          const value = scalePngSample(gray, depth);
          r = value;
          g = value;
          b = value;
          a = scalePngSample(readPngSample(passData, rowStart, base + 1, depth), depth);
        } else {
          r = scalePngSample(readPngSample(passData, rowStart, base, depth), depth);
          g = scalePngSample(readPngSample(passData, rowStart, base + 1, depth), depth);
          b = scalePngSample(readPngSample(passData, rowStart, base + 2, depth), depth);
          a = scalePngSample(readPngSample(passData, rowStart, base + 3, depth), depth);
        }
        out[target] = r;
        out[target + 1] = g;
        out[target + 2] = b;
        out[target + 3] = a;
      }
    }
  }

  return { width, height, rgba: out };
}

// ---------------------------------------------------------------------------
// JPEG decoding
// ---------------------------------------------------------------------------

/** Natural-order index of each zig-zag position. */
const ZIGZAG: Uint8Array = Uint8Array.from([
  0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48,
  41, 34, 27, 20, 13, 6, 7, 14, 21, 28, 35, 42, 49, 56, 57, 50, 43, 36, 29, 22,
  15, 23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55,
  62, 63,
]);

/**
 * Cosine basis of the 8-point DCT-II, `C(u) * cos((2x+1)u*pi/16)`, indexed
 * `u * 8 + x`. Both the inverse DCT and the forward DCT use it, so the two are
 * exact inverses of each other apart from quantization.
 */
const DCT_BASIS: Float64Array = (() => {
  const basis = new Float64Array(64);
  for (let u = 0; u < 8; u += 1) {
    const scale = u === 0 ? Math.SQRT1_2 : 1;
    for (let x = 0; x < 8; x += 1) {
      basis[u * 8 + x] = scale * Math.cos(((2 * x + 1) * u * Math.PI) / 16);
    }
  }
  return basis;
})();

/** Scratch for one 8x8 transform; this module never runs two at once. */
const DCT_SCRATCH = new Float64Array(64);

interface JpegHuffman {
  /** `mincode[l]` / `maxcode[l]` / `valptr[l]` for code length `l` (1..16). */
  mincode: Int32Array;
  maxcode: Int32Array;
  valptr: Int32Array;
  values: Uint8Array;
}

/** Builds the canonical JPEG Huffman decode tables (JPEG spec C.2 / F.16). */
function buildJpegHuffman(
  counts: ArrayLike<number>,
  values: ArrayLike<number>,
): JpegHuffman | null {
  const mincode = new Int32Array(17).fill(-1);
  const maxcode = new Int32Array(17).fill(-1);
  const valptr = new Int32Array(17);
  let code = 0;
  let index = 0;
  for (let length = 1; length <= 16; length += 1) {
    const count = counts[length - 1] ?? 0;
    if (count > 0) {
      mincode[length] = code;
      valptr[length] = index;
      code += count;
      index += count;
      maxcode[length] = code - 1;
    }
    code <<= 1;
  }
  if (index === 0 || index > values.length) return null;
  const table = new Uint8Array(index);
  for (let i = 0; i < index; i += 1) table[i] = (values[i] ?? 0) & 0xff;
  return { mincode, maxcode, valptr, values: table };
}

/** Bit reader over one entropy-coded segment, undoing `FF 00` stuffing. */
class JpegBitReader {
  private readonly data: Uint8Array;
  private pos = 0;
  private bits = 0;
  private count = 0;
  /** Set once the segment runs out of data or hits a marker. */
  exhausted = false;

  constructor(data: Uint8Array) {
    this.data = data;
  }

  private nextByte(): number {
    if (this.pos >= this.data.length) {
      this.exhausted = true;
      return -1;
    }
    const byte = this.data[this.pos]!;
    if (byte !== 0xff) {
      this.pos += 1;
      return byte;
    }
    let probe = this.pos + 1;
    while (probe < this.data.length && this.data[probe] === 0xff) probe += 1;
    if (probe >= this.data.length) {
      this.exhausted = true;
      this.pos = this.data.length;
      return -1;
    }
    if (this.data[probe] === 0x00) {
      this.pos = probe + 1;
      return 0xff;
    }
    // A real marker: entropy-coded data ended here.
    this.exhausted = true;
    this.pos = probe - 1;
    return -1;
  }

  readBit(): number {
    if (this.count === 0) {
      const byte = this.nextByte();
      if (byte < 0) return -1;
      this.bits = byte;
      this.count = 8;
    }
    this.count -= 1;
    return (this.bits >> this.count) & 1;
  }

  readBits(count: number): number {
    let value = 0;
    for (let i = 0; i < count; i += 1) {
      const bit = this.readBit();
      if (bit < 0) return -1;
      value = (value << 1) | bit;
    }
    return value;
  }

  /** Discards the partial byte and skips to just past the next restart marker. */
  restart(): boolean {
    this.bits = 0;
    this.count = 0;
    while (this.pos < this.data.length) {
      if (this.data[this.pos] !== 0xff) {
        this.pos += 1;
        continue;
      }
      let probe = this.pos + 1;
      while (probe < this.data.length && this.data[probe] === 0xff) probe += 1;
      if (probe >= this.data.length) return false;
      const marker = this.data[probe]!;
      if (marker === 0x00) {
        this.pos = probe + 1;
        continue;
      }
      if (marker >= 0xd0 && marker <= 0xd7) {
        this.pos = probe + 1;
        this.exhausted = false;
        return true;
      }
      this.pos = probe - 1;
      return false;
    }
    return false;
  }
}

function decodeJpegHuffman(
  reader: JpegBitReader,
  table: JpegHuffman,
): number {
  let code = 0;
  for (let length = 1; length <= 16; length += 1) {
    const bit = reader.readBit();
    if (bit < 0) return -1;
    code = (code << 1) | bit;
    const maxcode = table.maxcode[length]!;
    if (maxcode >= 0 && code <= maxcode) {
      const index = table.valptr[length]! + code - table.mincode[length]!;
      const value = table.values[index];
      return value === undefined ? -1 : value;
    }
  }
  return -1;
}

/** Reads `count` bits and sign-extends them (JPEG spec F.12), `null` on error. */
function receiveExtend(reader: JpegBitReader, count: number): number | null {
  if (count === 0) return 0;
  const value = reader.readBits(count);
  if (value < 0) return null;
  const threshold = 1 << (count - 1);
  return value < threshold ? value - ((1 << count) - 1) : value;
}

interface JpegComponent {
  id: number;
  /** Horizontal / vertical sampling factors. */
  h: number;
  v: number;
  quantTable: number;
  /** Coefficient planes, `blocksWide * blocksHigh` blocks of 64 values. */
  blocksWide: number;
  blocksHigh: number;
  coeffs: Int32Array;
  /** Reconstructed 8-bit samples. */
  plane: Uint8Array;
  planeWidth: number;
  planeHeight: number;
  dcPredictor: number;
}

interface JpegFrame {
  width: number;
  height: number;
  maxH: number;
  maxV: number;
  mcusX: number;
  mcusY: number;
  components: JpegComponent[];
}

/** Placeholder used for a component whose data the frame header did not declare. */
function createJpegComponent(
  id: number,
  h: number,
  v: number,
  quantTable: number,
  frame: { width: number; height: number; maxH: number; maxV: number; mcusX: number; mcusY: number },
): JpegComponent {
  const blocksWide = frame.mcusX * h;
  const blocksHigh = frame.mcusY * v;
  return {
    id,
    h,
    v,
    quantTable,
    blocksWide,
    blocksHigh,
    coeffs: new Int32Array(blocksWide * blocksHigh * 64),
    plane: new Uint8Array(blocksWide * 8 * blocksHigh * 8),
    planeWidth: blocksWide * 8,
    planeHeight: blocksHigh * 8,
    dcPredictor: 0,
  };
}

/** Inverse DCT of one quantized block, level-shifted into 8-bit samples. */
function idctBlock(
  coeffs: Int32Array,
  coeffBase: number,
  out: Uint8Array,
  outBase: number,
  outStride: number,
): void {
  const dc = coeffs[coeffBase]!;
  let hasAc = false;
  for (let i = 1; i < 64; i += 1) {
    if (coeffs[coeffBase + i] !== 0) {
      hasAc = true;
      break;
    }
  }
  if (!hasAc) {
    // Flat block: every sample is the DC level.
    const value = clampByte(Math.round(dc / 8) + 128);
    for (let y = 0; y < 8; y += 1) {
      out.fill(value, outBase + y * outStride, outBase + y * outStride + 8);
    }
    return;
  }

  const tmp = DCT_SCRATCH;
  for (let v = 0; v < 8; v += 1) {
    const rowBase = coeffBase + v * 8;
    for (let x = 0; x < 8; x += 1) {
      let sum = 0;
      for (let u = 0; u < 8; u += 1) {
        sum += coeffs[rowBase + u]! * DCT_BASIS[u * 8 + x]!;
      }
      tmp[v * 8 + x] = sum;
    }
  }
  for (let y = 0; y < 8; y += 1) {
    const rowOut = outBase + y * outStride;
    for (let x = 0; x < 8; x += 1) {
      let sum = 0;
      for (let v = 0; v < 8; v += 1) {
        sum += DCT_BASIS[v * 8 + y]! * tmp[v * 8 + x]!;
      }
      out[rowOut + x] = clampByte(Math.round(sum / 4) + 128);
    }
  }
}


interface JpegScanComponent {
  component: JpegComponent;
  /** Present only when the scan carries a DC band (`Ss == 0`). */
  dcTable: JpegHuffman | null;
  /** Present only when the scan carries an AC band (`Se > 0`). */
  acTable: JpegHuffman | null;
}

/**
 * Decodes one scan into the frame's coefficient planes. Progressive (SOF2) files
 * carry several scans that each fill or refine part of the spectrum, so this only
 * writes coefficients; `idctComponent` reconstructs samples once every scan is in.
 */
function decodeJpegScan(
  data: Uint8Array,
  frame: JpegFrame,
  scan: JpegScanComponent[],
  ss: number,
  se: number,
  ah: number,
  al: number,
  restartInterval: number,
): void {
  const reader = new JpegBitReader(data);
  const interleaved = scan.length > 1;
  /** End-of-band run, shared by the blocks of one restart interval. */
  let eobRun = 0;

  /**
   * DC coefficient of one block. A baseline scan carries `Ss=0, Se=63` and so
   * needs this *and* the AC pass; a progressive DC scan (`Se=0`) needs only this.
   */
  const decodeDc = (entry: JpegScanComponent, coeffs: Int32Array, base: number): boolean => {
    const component = entry.component;
    if (ah === 0) {
      const category = decodeJpegHuffman(reader, entry.dcTable!);
      if (category < 0) return false;
      const difference = receiveExtend(reader, category);
      if (difference === null) return false;
      component.dcPredictor += difference;
      coeffs[base] = component.dcPredictor << al;
      return true;
    }
    const bit = reader.readBit();
    if (bit < 0) return false;
    if (bit !== 0) coeffs[base] = coeffs[base]! | (1 << al);
    return true;
  };

  /** AC band `[from, se]` of one block: first pass, then refinement. */
  const decodeAc = (
    entry: JpegScanComponent,
    coeffs: Int32Array,
    base: number,
    from: number,
  ): boolean => {
    if (ah === 0) {
      // AC first pass: the band starts at zero, so a run means "nothing here".
      if (eobRun > 0) {
        eobRun -= 1;
        return true;
      }
      for (let k = from; k <= se; k += 1) {
        const rs = decodeJpegHuffman(reader, entry.acTable!);
        if (rs < 0) return false;
        const runLength = rs >> 4;
        const size = rs & 15;
        if (size === 0) {
          if (runLength !== 15) {
            eobRun = 1 << runLength;
            if (runLength > 0) {
              const extra = reader.readBits(runLength);
              if (extra < 0) return false;
              eobRun += extra;
            }
            eobRun -= 1;
            break;
          }
          k += 15;
          continue;
        }
        k += runLength;
        if (k > se) return false;
        const value = receiveExtend(reader, size);
        if (value === null) return false;
        coeffs[base + ZIGZAG[k]!] = value * (1 << al);
      }
      return true;
    }

    // AC refinement: adds one bit of precision to coefficients already present.
    const p1 = 1 << al;
    const m1 = -1 * (1 << al);
    let k = from;
    if (eobRun === 0) {
      for (; k <= se; k += 1) {
        const rs = decodeJpegHuffman(reader, entry.acTable!);
        if (rs < 0) return false;
        let runLength = rs >> 4;
        let size = rs & 15;
        if (size !== 0) {
          if (size !== 1) return false;
          const bit = reader.readBit();
          if (bit < 0) return false;
          size = bit !== 0 ? p1 : m1;
        } else if (runLength !== 15) {
          eobRun = 1 << runLength;
          if (runLength > 0) {
            const extra = reader.readBits(runLength);
            if (extra < 0) return false;
            eobRun += extra;
          }
          break;
        }
        while (k <= se) {
          const index = base + ZIGZAG[k]!;
          const coefficient = coeffs[index]!;
          if (coefficient !== 0) {
            const bit = reader.readBit();
            if (bit < 0) return false;
            if (bit !== 0 && (coefficient & p1) === 0) {
              coeffs[index] = coefficient >= 0 ? coefficient + p1 : coefficient + m1;
            }
          } else {
            if (runLength === 0) break;
            runLength -= 1;
          }
          k += 1;
        }
        if (size !== 0) {
          if (k > se) return false;
          coeffs[base + ZIGZAG[k]!] = size;
        }
      }
    }
    if (eobRun > 0) {
      // Every remaining non-zero coefficient of this block takes a correction bit.
      for (; k <= se; k += 1) {
        const index = base + ZIGZAG[k]!;
        const coefficient = coeffs[index]!;
        if (coefficient === 0) continue;
        const bit = reader.readBit();
        if (bit < 0) return false;
        if (bit !== 0 && (coefficient & p1) === 0) {
          coeffs[index] = coefficient >= 0 ? coefficient + p1 : coefficient + m1;
        }
      }
      eobRun -= 1;
    }
    return true;
  };

  const decodeBlock = (
    entry: JpegScanComponent,
    coeffs: Int32Array,
    base: number,
  ): boolean => {
    if (ss === 0 && !decodeDc(entry, coeffs, base)) return false;
    // A baseline scan selects the whole spectrum (`Ss=0, Se=63`), so its AC band
    // starts at 1; a progressive AC scan starts at its own `Ss`.
    if (se > 0 && !decodeAc(entry, coeffs, base, ss === 0 ? 1 : ss)) return false;
    return true;
  };

  const first = scan[0]!;
  // A non-interleaved scan walks the component's own block grid, which may be
  // smaller than the MCU-padded coefficient plane.
  const blocksWide = interleaved
    ? 0
    : Math.min(
        first.component.blocksWide,
        Math.ceil(Math.ceil((frame.width * first.component.h) / frame.maxH) / 8),
      );
  const blocksHigh = interleaved
    ? 0
    : Math.min(
        first.component.blocksHigh,
        Math.ceil(Math.ceil((frame.height * first.component.v) / frame.maxV) / 8),
      );
  const totalUnits = interleaved
    ? frame.mcusX * frame.mcusY
    : blocksWide * blocksHigh;

  let sinceRestart = 0;
  for (let unit = 0; unit < totalUnits; unit += 1) {
    if (restartInterval > 0 && sinceRestart === restartInterval) {
      if (!reader.restart()) return;
      sinceRestart = 0;
      eobRun = 0;
      for (const entry of scan) entry.component.dcPredictor = 0;
    }

    if (interleaved) {
      const mx = unit % frame.mcusX;
      const my = (unit - mx) / frame.mcusX;
      for (const entry of scan) {
        const component = entry.component;
        for (let v = 0; v < component.v; v += 1) {
          for (let h = 0; h < component.h; h += 1) {
            const bx = mx * component.h + h;
            const by = my * component.v + v;
            const base = (by * component.blocksWide + bx) * 64;
            if (!decodeBlock(entry, component.coeffs, base)) return;
          }
        }
      }
    } else {
      const bx = unit % blocksWide;
      const by = (unit - bx) / blocksWide;
      const base = (by * first.component.blocksWide + bx) * 64;
      if (!decodeBlock(first, first.component.coeffs, base)) return;
    }
    sinceRestart += 1;
  }
}

/** Reconstructs 8-bit samples for one component from its quantized coefficients. */
function idctComponent(component: JpegComponent, quant: Int32Array | null): void {
  const { coeffs, plane, planeWidth, blocksWide, blocksHigh } = component;
  for (let by = 0; by < blocksHigh; by += 1) {
    for (let bx = 0; bx < blocksWide; bx += 1) {
      const base = (by * blocksWide + bx) * 64;
      if (quant !== null) {
        for (let i = 0; i < 64; i += 1) {
          const step = quant[i]!;
          coeffs[base + i] = step === 0 ? 0 : coeffs[base + i]! * step;
        }
      }
      idctBlock(coeffs, base, plane, by * 8 * planeWidth + bx * 8, planeWidth);
    }
  }
}

/** Position of the marker that ends an entropy-coded segment (or the end). */
function findJpegEntropyEnd(raw: Uint8Array, start: number): number {
  let off = start;
  while (off + 1 < raw.length) {
    if (raw[off] !== 0xff) {
      off += 1;
      continue;
    }
    const marker = raw[off + 1]!;
    if (marker === 0xff) {
      off += 1;
      continue;
    }
    if (marker === 0x00 || (marker >= 0xd0 && marker <= 0xd7)) {
      off += 2;
      continue;
    }
    return off;
  }
  return raw.length;
}

function decodeJpeg(raw: Uint8Array): RgbaImage | null {
  if (raw.length < 4 || raw[0] !== 0xff || raw[1] !== 0xd8) return null;

  const quantTables: Array<Int32Array | null> = [null, null, null, null];
  const dcTables: Array<JpegHuffman | null> = [null, null, null, null];
  const acTables: Array<JpegHuffman | null> = [null, null, null, null];
  let frame: JpegFrame | null = null;
  let restartInterval = 0;
  let adobeTransform = -1;

  try {
    let off = 2;
    while (off + 1 < raw.length) {
      if (raw[off] !== 0xff) {
        off += 1;
        continue;
      }
      const marker = raw[off + 1]!;
      if (marker === 0xff) {
        off += 1;
        continue;
      }
      off += 2;
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        continue;
      }
      if (marker === 0xd9) break;
      const length = readU16BE(raw, off);
      if (length < 2 || off + length > raw.length) break;
      const segment = raw.subarray(off + 2, off + length);

      if (marker === 0xdb) {
        let p = 0;
        while (p < segment.length) {
          const info = segment[p]!;
          const wide = (info >> 4) === 1;
          const index = info & 15;
          p += 1;
          const table = new Int32Array(64);
          for (let i = 0; i < 64; i += 1) {
            table[ZIGZAG[i]!] = wide ? readU16BE(segment, p) : segment[p]!;
            p += wide ? 2 : 1;
          }
          if (index < 4) quantTables[index] = table;
        }
      } else if (marker === 0xc4) {
        let p = 0;
        while (p < segment.length) {
          const info = segment[p]!;
          const isAc = (info >> 4) === 1;
          const index = info & 15;
          p += 1;
          const counts = segment.subarray(p, p + 16);
          p += 16;
          let total = 0;
          for (let i = 0; i < 16; i += 1) total += counts[i]!;
          const values = segment.subarray(p, p + total);
          p += total;
          const table = buildJpegHuffman(counts, values);
          if (table === null) return null;
          if (index < 4) {
            if (isAc) acTables[index] = table;
            else dcTables[index] = table;
          }
        }
      } else if (marker === 0xdd) {
        restartInterval = readU16BE(segment, 0);
      } else if (marker === 0xee) {
        if (segment.length >= 12 && matchesAscii(segment, 0, "Adobe")) {
          adobeTransform = segment[11]!;
        }
      } else if (isSofMarker(marker)) {
        if (segment.length < 6) return null;
        // Only baseline (SOF0), extended sequential (SOF1) and progressive
        // (SOF2) Huffman frames are decodable here; arithmetic-coded and
        // lossless SOF processes would decode to garbage instead of failing.
        const progressive = marker === 0xc2;
        if (marker !== 0xc0 && marker !== 0xc1 && !progressive) return null;
        const precision = segment[0]!;
        const height = readU16BE(segment, 1);
        const width = readU16BE(segment, 3);
        const count = segment[5]!;
        // 8-bit precision is everything the callers can produce or upload.
        if (precision !== 8) return null;
        if (width <= 0 || height <= 0) return null;
        if (count !== 1 && count !== 3 && count !== 4) return null;
        if (segment.length < 6 + count * 3) return null;
        const specs: Array<{ id: number; h: number; v: number; tq: number }> = [];
        let maxH = 1;
        let maxV = 1;
        for (let i = 0; i < count; i += 1) {
          const base = 6 + i * 3;
          const id = segment[base]!;
          const sampling = segment[base + 1]!;
          const h = Math.max(1, sampling >> 4);
          const v = Math.max(1, sampling & 15);
          const tq = segment[base + 2]!;
          maxH = Math.max(maxH, h);
          maxV = Math.max(maxV, v);
          specs.push({ id, h, v, tq });
        }
        const shape = {
          width,
          height,
          maxH,
          maxV,
          mcusX: Math.ceil(width / (8 * maxH)),
          mcusY: Math.ceil(height / (8 * maxV)),
        };
        // Budget the real allocations before making them: each component keeps a
        // 32-bit coefficient plane (4 bytes/sample) *and* an 8-bit sample plane,
        // which together dwarf the RGBA estimate the entry guard uses. An
        // 8000x8000 4:4:4 frame needs ~960 MB here versus 256 MB of RGBA.
        let componentBytes = 0;
        for (const spec of specs) {
          const blocksWide = shape.mcusX * spec.h;
          const blocksHigh = shape.mcusY * spec.v;
          componentBytes += blocksWide * blocksHigh * 64 * 4;
          componentBytes += blocksWide * 8 * blocksHigh * 8;
        }
        const rgbaBytes = width * height * 4;
        if (
          !Number.isSafeInteger(componentBytes) ||
          !Number.isSafeInteger(rgbaBytes) ||
          raw.length + componentBytes + rgbaBytes > MAX_DECODE_HOLD_BYTES
        ) {
          return null;
        }
        frame = {
          width,
          height,
          maxH,
          maxV,
          mcusX: shape.mcusX,
          mcusY: shape.mcusY,
          components: specs.map((spec) =>
            createJpegComponent(spec.id, spec.h, spec.v, spec.tq, shape),
          ),
        };
      } else if (marker === 0xda) {
        if (frame === null) return null;
        const count = segment[0]!;
        if (segment.length < 1 + count * 2 + 3) return null;
        const ss = segment[1 + count * 2]!;
        const se = segment[2 + count * 2]!;
        const ah = (segment[3 + count * 2]! >> 4) & 15;
        const al = segment[3 + count * 2]! & 15;
        const scan: JpegScanComponent[] = [];
        for (let i = 0; i < count; i += 1) {
          const id = segment[1 + i * 2]!;
          const selectors = segment[2 + i * 2]!;
          const component = frame.components.find((c) => c.id === id);
          if (component === undefined) return null;
          // A progressive DC scan names no AC table and vice versa, so only the
          // table the scan actually uses has to be present.
          const dcTable = ss === 0 ? (dcTables[(selectors >> 4) & 15] ?? null) : null;
          const acTable = se > 0 ? (acTables[selectors & 15] ?? null) : null;
          if (ss === 0 && dcTable === null) return null;
          if (se > 0 && acTable === null) return null;
          scan.push({ component, dcTable, acTable });
        }
        const entropyStart = off + length;
        const entropyEnd = findJpegEntropyEnd(raw, entropyStart);
        decodeJpegScan(
          raw.subarray(entropyStart, entropyEnd),
          frame,
          scan,
          ss,
          se,
          ah,
          al,
          restartInterval,
        );
        off = entropyEnd;
        if (entropyEnd >= raw.length) break;
        continue;
      }

      off += length;
    }
  } catch {
    return null;
  }

  if (frame === null) return null;
  for (const component of frame.components) {
    const quant = quantTables[component.quantTable] ?? null;
    if (quant === null) return null;
    idctComponent(component, quant);
  }
  return jpegToRgba(frame, adobeTransform);
}

function jpegToRgba(frame: JpegFrame, adobeTransform: number): RgbaImage | null {
  const { width, height, maxH, maxV, components } = frame;
  const count = components.length;
  if (count !== 1 && count !== 3 && count !== 4) return null;

  const out = createRgba(width, height);
  // Nearest-neighbour chroma upsampling: the result is scaled down to at most
  // `MAX_INLINE_IMAGE_SIDE` right afterwards, so a fancier filter would be lost.
  const columnIndex: Int32Array[] = [];
  const rowIndex: Int32Array[] = [];
  for (const component of components) {
    const columns = new Int32Array(width);
    for (let x = 0; x < width; x += 1) {
      const sx = Math.floor((x * component.h) / maxH);
      columns[x] = Math.min(sx, component.planeWidth - 1);
    }
    const rows = new Int32Array(height);
    for (let y = 0; y < height; y += 1) {
      const sy = Math.floor((y * component.v) / maxV);
      rows[y] = Math.min(sy, component.planeHeight - 1);
    }
    columnIndex.push(columns);
    rowIndex.push(rows);
  }

  const planes = components.map((component) => component.plane);
  const strides = components.map((component) => component.planeWidth);
  const columns0 = columnIndex[0]!;
  const rows0 = rowIndex[0]!;

  if (count === 1) {
    const plane = planes[0]!;
    const stride = strides[0]!;
    for (let y = 0; y < height; y += 1) {
      const rowBase = rows0[y]! * stride;
      for (let x = 0; x < width; x += 1) {
        const value = plane[rowBase + columns0[x]!]!;
        const target = (y * width + x) * 4;
        out[target] = value;
        out[target + 1] = value;
        out[target + 2] = value;
        out[target + 3] = 255;
      }
    }
    return { width, height, rgba: out };
  }

  const plane1 = planes[1]!;
  const plane2 = planes[2]!;
  const stride1 = strides[1]!;
  const stride2 = strides[2]!;
  const columns1 = columnIndex[1]!;
  const columns2 = columnIndex[2]!;
  const rows1 = rowIndex[1]!;
  const rows2 = rowIndex[2]!;

  if (count === 3) {
    const plane0 = planes[0]!;
    const stride0 = strides[0]!;
    for (let y = 0; y < height; y += 1) {
      const row0 = rows0[y]! * stride0;
      const rowCb = rows1[y]! * stride1;
      const rowCr = rows2[y]! * stride2;
      for (let x = 0; x < width; x += 1) {
        const luma = plane0[row0 + columns0[x]!]!;
        const cb = plane1[rowCb + columns1[x]!]! - 128;
        const cr = plane2[rowCr + columns2[x]!]! - 128;
        const target = (y * width + x) * 4;
        out[target] = clampByte(Math.round(luma + 1.402 * cr));
        out[target + 1] = clampByte(
          Math.round(luma - 0.344136 * cb - 0.714136 * cr),
        );
        out[target + 2] = clampByte(Math.round(luma + 1.772 * cb));
        out[target + 3] = 255;
      }
    }
    return { width, height, rgba: out };
  }

  // Four components: CMYK, or YCCK when Adobe's APP14 says transform 2.
  const plane0 = planes[0]!;
  const plane3 = planes[3]!;
  const stride0 = strides[0]!;
  const stride3 = strides[3]!;
  const columns3 = columnIndex[3]!;
  const rows3 = rowIndex[3]!;
  const ycck = adobeTransform === 2;
  for (let y = 0; y < height; y += 1) {
    const row0 = rows0[y]! * stride0;
    const row1 = rows1[y]! * stride1;
    const row2 = rows2[y]! * stride2;
    const row3 = rows3[y]! * stride3;
    for (let x = 0; x < width; x += 1) {
      const c0 = plane0[row0 + columns0[x]!]!;
      const c1 = plane1[row1 + columns1[x]!]!;
      const c2 = plane2[row2 + columns2[x]!]!;
      const c3 = plane3[row3 + columns3[x]!]!;
      let cyan: number;
      let magenta: number;
      let yellow: number;
      if (ycck) {
        const cb = c1 - 128;
        const cr = c2 - 128;
        cyan = 255 - clampByte(Math.round(c0 + 1.402 * cr));
        magenta = 255 - clampByte(Math.round(c0 - 0.344136 * cb - 0.714136 * cr));
        yellow = 255 - clampByte(Math.round(c0 + 1.772 * cb));
      } else {
        cyan = c0;
        magenta = c1;
        yellow = c2;
      }
      const target = (y * width + x) * 4;
      out[target] = clampByte(255 - Math.min(255, cyan + c3));
      out[target + 1] = clampByte(255 - Math.min(255, magenta + c3));
      out[target + 2] = clampByte(255 - Math.min(255, yellow + c3));
      out[target + 3] = 255;
    }
  }
  return { width, height, rgba: out };
}

// ---------------------------------------------------------------------------
// GIF decoding
// ---------------------------------------------------------------------------

function decodeGif(raw: Uint8Array): RgbaImage | null {
  if (raw.length < 13) return null;
  if (!matchesAscii(raw, 0, "GIF8")) return null;
  const width = readU16LE(raw, 6);
  const height = readU16LE(raw, 8);
  const packed = raw[10]!;
  if (width <= 0 || height <= 0) return null;

  const out = createRgba(width, height);
  let globalTable: Uint8Array | null = null;
  let off = 13;
  if ((packed & 0x80) !== 0) {
    const entries = 2 << (packed & 7);
    if (off + entries * 3 > raw.length) return null;
    globalTable = raw.subarray(off, off + entries * 3);
    off += entries * 3;
  }

  let transparentIndex = -1;
  while (off < raw.length) {
    const introducer = raw[off]!;
    if (introducer === 0x3b) break; // trailer
    if (introducer === 0x21) {
      // Extension: label then sub-blocks. A graphic control extension carries the
      // transparency index we need to honour.
      const label = raw[off + 1];
      off += 2;
      if (label === 0xf9 && raw[off]! >= 4) {
        const flags = raw[off + 1]!;
        if ((flags & 1) !== 0) transparentIndex = raw[off + 4]!;
      }
      while (off < raw.length) {
        const size = raw[off]!;
        off += 1;
        if (size === 0) break;
        off += size;
      }
      continue;
    }
    if (introducer !== 0x2c) return null; // not an image descriptor

    if (off + 10 > raw.length) return null;
    const left = readU16LE(raw, off + 1);
    const top = readU16LE(raw, off + 3);
    const frameWidth = readU16LE(raw, off + 5);
    const frameHeight = readU16LE(raw, off + 7);
    const imagePacked = raw[off + 9]!;
    off += 10;
    let colorTable = globalTable;
    if ((imagePacked & 0x80) !== 0) {
      const entries = 2 << (imagePacked & 7);
      if (off + entries * 3 > raw.length) return null;
      colorTable = raw.subarray(off, off + entries * 3);
      off += entries * 3;
    }
    if (colorTable === null) return null;
    if (off >= raw.length) return null;
    const minimumCodeSize = raw[off]!;
    off += 1;

    const blocks: Uint8Array[] = [];
    let total = 0;
    while (off < raw.length) {
      const size = raw[off]!;
      off += 1;
      if (size === 0) break;
      if (off + size > raw.length) return null;
      blocks.push(raw.subarray(off, off + size));
      total += size;
      off += size;
    }
    const lzw = new Uint8Array(total);
    let cursor = 0;
    for (const block of blocks) {
      lzw.set(block, cursor);
      cursor += block.length;
    }

    const pixelCount = frameWidth * frameHeight;
    if (pixelCount <= 0) return null;
    const rgbaBytes = width * height * 4;
    if (
      !Number.isSafeInteger(pixelCount) ||
      !Number.isSafeInteger(rgbaBytes) ||
      raw.length + pixelCount + rgbaBytes > MAX_DECODE_HOLD_BYTES
    ) {
      return null;
    }
    const indices = new Uint8Array(pixelCount);
    if (!lzwDecode(lzw, minimumCodeSize, indices)) return null;

    const interlaced = (imagePacked & 0x40) !== 0;
    const rows = interlaced ? gifInterlacedRows(frameHeight) : null;
    for (let row = 0; row < frameHeight; row += 1) {
      const y = top + (rows === null ? row : rows[row]!);
      if (y < 0 || y >= height) continue;
      for (let column = 0; column < frameWidth; column += 1) {
        const x = left + column;
        if (x < 0 || x >= width) continue;
        const index = indices[row * frameWidth + column]!;
        const target = (y * width + x) * 4;
        if (index === transparentIndex) continue;
        out[target] = colorTable[index * 3] ?? 0;
        out[target + 1] = colorTable[index * 3 + 1] ?? 0;
        out[target + 2] = colorTable[index * 3 + 2] ?? 0;
        out[target + 3] = 255;
      }
    }
    // Only the first frame is drawn: a resized still is all we need, and an
    // animation's later frames would need compositing to mean anything.
    return { width, height, rgba: out };
  }

  return null;
}

function gifInterlacedRows(height: number): Int32Array {
  const rows = new Int32Array(height);
  let cursor = 0;
  for (const [start, step] of [
    [0, 8],
    [4, 8],
    [2, 4],
    [1, 2],
  ] as const) {
    for (let y = start; y < height; y += step) {
      if (cursor < height) rows[cursor] = y;
      cursor += 1;
    }
  }
  return rows;
}

/** Variable-width LZW as GIF encodes it (up to 12-bit codes, clear and EOI). */
function lzwDecode(data: Uint8Array, minimumCodeSize: number, out: Uint8Array): boolean {
  // A GIF LZW minimum code size is 2..8; anything larger makes `1 << size` an
  // enormous clear code and the dictionary reset would spin for ~1e9 iterations
  // (event-loop stall from a few bytes of input).
  if (!Number.isInteger(minimumCodeSize) || minimumCodeSize < 1 || minimumCodeSize > 8) {
    return false;
  }
  const clearCode = 1 << minimumCodeSize;
  const endCode = clearCode + 1;
  const prefix = new Int32Array(4096);
  const suffix = new Uint8Array(4096);
  const stack = new Uint8Array(4097);

  const reset = (): void => {
    for (let i = 0; i < clearCode; i += 1) {
      prefix[i] = -1;
      suffix[i] = i;
    }
    for (let i = clearCode; i < 4096; i += 1) prefix[i] = -1;
  };

  let codeSize = minimumCodeSize + 1;
  let nextCode = endCode + 1;
  let previous = -1;
  let bitBuffer = 0;
  let bitCount = 0;
  let position = 0;
  let written = 0;
  reset();

  const readCode = (): number => {
    while (bitCount < codeSize) {
      if (position >= data.length) return -1;
      bitBuffer |= data[position]! << bitCount;
      position += 1;
      bitCount += 8;
    }
    const code = bitBuffer & ((1 << codeSize) - 1);
    bitBuffer >>= codeSize;
    bitCount -= codeSize;
    return code;
  };

  /** Pushes the string for `code` onto `stack`, returns its length. */
  const expand = (code: number): number => {
    let length = 0;
    let current = code;
    while (current >= 0 && length <= 4096) {
      stack[length] = suffix[current]!;
      length += 1;
      current = prefix[current]!;
    }
    return length;
  };

  while (written < out.length) {
    const code = readCode();
    if (code < 0 || code === endCode) break;
    if (code === clearCode) {
      codeSize = minimumCodeSize + 1;
      nextCode = endCode + 1;
      previous = -1;
      reset();
      continue;
    }
    if (previous < 0) {
      if (code >= clearCode) return false;
      out[written] = suffix[code]!;
      written += 1;
      previous = code;
      continue;
    }
    let firstByte: number;
    if (code < nextCode) {
      const length = expand(code);
      for (let i = length - 1; i >= 0; i -= 1) {
        if (written >= out.length) break;
        out[written] = stack[i]!;
        written += 1;
      }
      firstByte = stack[length - 1] ?? 0;
    } else if (code === nextCode) {
      const length = expand(previous);
      firstByte = stack[length - 1] ?? 0;
      const copy = new Uint8Array(length);
      for (let i = length - 1; i >= 0; i -= 1) copy[length - 1 - i] = stack[i]!;
      if (written < out.length) {
        for (const byte of copy) {
          if (written >= out.length) break;
          out[written] = byte;
          written += 1;
        }
      }
      if (written < out.length) {
        out[written] = firstByte;
        written += 1;
      }
    } else {
      return false;
    }
    if (nextCode < 4096) {
      prefix[nextCode] = previous;
      suffix[nextCode] = firstByte!;
      nextCode += 1;
      if (nextCode === 1 << codeSize && codeSize < 12) codeSize += 1;
    }
    previous = code;
  }
  return written > 0;
}

// ---------------------------------------------------------------------------
// Decode entry point
// ---------------------------------------------------------------------------

/**
 * Decodes already-probed bytes into RGBA8, `null` on anything it cannot handle.
 *
 * Split out of `decodeImageRgba` so the inline-image fitter, which had to probe
 * the dimensions anyway, does not parse the same header twice. Never throws:
 * untrusted bytes surface as `null` (passed through untouched).
 */
function decodeCheckedImageRgba(raw: Uint8Array, dimensions: ImageDimensions): RgbaImage | null {
  try {
    switch (dimensions.format) {
      case "png":
        return decodePng(raw);
      case "jpeg":
        return decodeJpeg(raw);
      case "gif":
        return decodeGif(raw);
      case "webp": {
        const decoded = decodeWebp(raw, MAX_DECODE_HOLD_BYTES);
        if (
          decoded === null ||
          decoded.width !== dimensions.width ||
          decoded.height !== dimensions.height
        ) {
          return null;
        }
        return decoded;
      }
    }
  } catch {
    return null;
  }
}

/**
 * Decodes any PNG, JPEG, GIF or still WebP this module understands into RGBA8.
 *
 * Never throws: image bytes are untrusted caller input, so an unexpected
 * allocation or malformed chunk surfaces as `null` (the image is passed
 * through untouched) rather than as a failed turn.
 */
export function decodeImageRgba(raw: Uint8Array): RgbaImage | null {
  try {
    const dimensions = readImageDimensions(raw);
    if (dimensions === null) return null;
    const pixels = dimensions.width * dimensions.height;
    if (!Number.isFinite(pixels) || pixels <= 0) return null;
    if (raw.length + pixels * 4 > MAX_DECODE_HOLD_BYTES) return null;
    return decodeCheckedImageRgba(raw, dimensions);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Resampling
// ---------------------------------------------------------------------------

/**
 * Area-average resample, separable: the exact average of the source pixels each
 * target pixel covers, so a screenshot's fine detail averages rather than aliases.
 */
export function resizeRgba(source: RgbaImage, targetWidth: number, targetHeight: number): RgbaImage {
  const { width, height, rgba } = source;
  const tw = Math.max(1, Math.min(targetWidth, width));
  const th = Math.max(1, Math.min(targetHeight, height));
  if (tw === width && th === height) {
    return { width, height, rgba };
  }

  // Horizontal pass into float RGB(A), then vertical into bytes.
  const intermediate = new Float32Array(tw * height * 4);
  const xScale = width / tw;
  for (let y = 0; y < height; y += 1) {
    const srcRow = y * width * 4;
    const dstRow = y * tw * 4;
    for (let x = 0; x < tw; x += 1) {
      const start = x * xScale;
      const end = Math.min(width, (x + 1) * xScale);
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let weightTotal = 0;
      for (let sx = Math.floor(start); sx < Math.ceil(end); sx += 1) {
        const weight = Math.min(end, sx + 1) - Math.max(start, sx);
        if (weight <= 0) continue;
        const src = srcRow + sx * 4;
        r += rgba[src]! * weight;
        g += rgba[src + 1]! * weight;
        b += rgba[src + 2]! * weight;
        a += rgba[src + 3]! * weight;
        weightTotal += weight;
      }
      const dst = dstRow + x * 4;
      const divisor = weightTotal > 0 ? weightTotal : 1;
      intermediate[dst] = r / divisor;
      intermediate[dst + 1] = g / divisor;
      intermediate[dst + 2] = b / divisor;
      intermediate[dst + 3] = a / divisor;
    }
  }

  const out = createRgba(tw, th);
  const yScale = height / th;
  for (let y = 0; y < th; y += 1) {
    const start = y * yScale;
    const end = Math.min(height, (y + 1) * yScale);
    const dstRow = y * tw * 4;
    for (let x = 0; x < tw; x += 1) {
      const column = x * 4;
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let weightTotal = 0;
      for (let sy = Math.floor(start); sy < Math.ceil(end); sy += 1) {
        const weight = Math.min(end, sy + 1) - Math.max(start, sy);
        if (weight <= 0) continue;
        const src = sy * tw * 4 + column;
        r += intermediate[src]! * weight;
        g += intermediate[src + 1]! * weight;
        b += intermediate[src + 2]! * weight;
        a += intermediate[src + 3]! * weight;
        weightTotal += weight;
      }
      const divisor = weightTotal > 0 ? weightTotal : 1;
      const dst = dstRow + column;
      out[dst] = clampByte(Math.round(r / divisor));
      out[dst + 1] = clampByte(Math.round(g / divisor));
      out[dst + 2] = clampByte(Math.round(b / divisor));
      out[dst + 3] = clampByte(Math.round(a / divisor));
    }
  }
  return { width: tw, height: th, rgba: out };
}

// ---------------------------------------------------------------------------
// PNG encoding
// ---------------------------------------------------------------------------

const CRC_TABLE: Int32Array = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = -1;
  for (let i = 0; i < bytes.length; i += 1) {
    crc = CRC_TABLE[(crc ^ bytes[i]!) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ -1) >>> 0;
}

class ByteSink {
  private buffer = new Uint8Array(1 << 16);
  private length = 0;

  push(byte: number): void {
    if (this.length >= this.buffer.length) {
      const grown = new Uint8Array(this.buffer.length * 2);
      grown.set(this.buffer);
      this.buffer = grown;
    }
    this.buffer[this.length] = byte & 0xff;
    this.length += 1;
  }

  pushAll(bytes: Uint8Array): void {
    for (let i = 0; i < bytes.length; i += 1) this.push(bytes[i]!);
  }

  pushU32(value: number): void {
    this.push((value >>> 24) & 0xff);
    this.push((value >>> 16) & 0xff);
    this.push((value >>> 8) & 0xff);
    this.push(value & 0xff);
  }

  pushU16(value: number): void {
    this.push((value >>> 8) & 0xff);
    this.push(value & 0xff);
  }

  get size(): number {
    return this.length;
  }

  toUint8Array(): Uint8Array {
    return this.buffer.subarray(0, this.length);
  }
}

function writePngChunk(sink: ByteSink, type: string, payload: Uint8Array): void {
  sink.pushU32(payload.length);
  const typed = new Uint8Array(4 + payload.length);
  for (let i = 0; i < 4; i += 1) typed[i] = type.charCodeAt(i) & 0xff;
  typed.set(payload, 4);
  sink.pushAll(typed);
  sink.pushU32(crc32(typed));
}

/** Encodes RGBA8 as a non-interlaced 8-bit PNG with per-row `Sub` filtering. */
export function encodePngRgba(width: number, height: number, rgba: Uint8Array): Uint8Array {
  const stride = width * 4;
  const raw = new Uint8Array(height * (stride + 1));
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (stride + 1);
    raw[rowStart] = 1; // filter: Sub
    const src = y * stride;
    for (let i = 0; i < stride; i += 1) {
      const left = i >= 4 ? rgba[src + i - 4]! : 0;
      raw[rowStart + 1 + i] = (rgba[src + i]! - left) & 0xff;
    }
  }
  const compressed = deflateSync(Buffer.from(raw));

  const sink = new ByteSink();
  sink.pushAll(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const ihdr = new Uint8Array(13);
  ihdr[0] = (width >>> 24) & 0xff;
  ihdr[1] = (width >>> 16) & 0xff;
  ihdr[2] = (width >>> 8) & 0xff;
  ihdr[3] = width & 0xff;
  ihdr[4] = (height >>> 24) & 0xff;
  ihdr[5] = (height >>> 16) & 0xff;
  ihdr[6] = (height >>> 8) & 0xff;
  ihdr[7] = height & 0xff;
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: truecolour with alpha
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // non-interlaced
  writePngChunk(sink, "IHDR", ihdr);
  writePngChunk(sink, "IDAT", compressed);
  writePngChunk(sink, "IEND", new Uint8Array(0));
  return sink.toUint8Array().slice();
}

// ---------------------------------------------------------------------------
// JPEG encoding
// ---------------------------------------------------------------------------

const STD_LUMA_QUANT: readonly number[] = [
  16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55, 14, 13, 16, 24,
  40, 57, 69, 56, 14, 17, 22, 29, 51, 87, 80, 62, 18, 22, 37, 56, 68, 109, 103,
  77, 24, 35, 55, 64, 81, 104, 113, 92, 49, 64, 78, 87, 103, 121, 120, 101, 72,
  92, 95, 98, 112, 100, 103, 99,
];

const STD_CHROMA_QUANT: readonly number[] = [
  17, 18, 24, 47, 99, 99, 99, 99, 18, 21, 26, 66, 99, 99, 99, 99, 24, 26, 56, 99,
  99, 99, 99, 99, 47, 66, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99,
];

/** Annex K.3 DC/AC Huffman tables, luminance and chrominance. */
const STD_DC_LUMA_BITS: readonly number[] = [
  0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0,
];
const STD_DC_LUMA_VALUES: readonly number[] = [
  0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11,
];
const STD_DC_CHROMA_BITS: readonly number[] = [
  0, 3, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0,
];
const STD_DC_CHROMA_VALUES: readonly number[] = [
  0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11,
];
const STD_AC_LUMA_BITS: readonly number[] = [
  0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 0x7d,
];
const STD_AC_LUMA_VALUES: readonly number[] = [
  0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06, 0x13,
  0x51, 0x61, 0x07, 0x22, 0x71, 0x14, 0x32, 0x81, 0x91, 0xa1, 0x08, 0x23, 0x42,
  0xb1, 0xc1, 0x15, 0x52, 0xd1, 0xf0, 0x24, 0x33, 0x62, 0x72, 0x82, 0x09, 0x0a,
  0x16, 0x17, 0x18, 0x19, 0x1a, 0x25, 0x26, 0x27, 0x28, 0x29, 0x2a, 0x34, 0x35,
  0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4a,
  0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67,
  0x68, 0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x83, 0x84,
  0x85, 0x86, 0x87, 0x88, 0x89, 0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98,
  0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3,
  0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7,
  0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe1,
  0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf1, 0xf2, 0xf3, 0xf4,
  0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa,
];
const STD_AC_CHROMA_BITS: readonly number[] = [
  0, 2, 1, 2, 4, 4, 3, 4, 7, 5, 4, 4, 0, 1, 2, 0x77,
];
const STD_AC_CHROMA_VALUES: readonly number[] = [
  0x00, 0x01, 0x02, 0x03, 0x11, 0x04, 0x05, 0x21, 0x31, 0x06, 0x12, 0x41, 0x51,
  0x07, 0x61, 0x71, 0x13, 0x22, 0x32, 0x81, 0x08, 0x14, 0x42, 0x91, 0xa1, 0xb1,
  0xc1, 0x09, 0x23, 0x33, 0x52, 0xf0, 0x15, 0x62, 0x72, 0xd1, 0x0a, 0x16, 0x24,
  0x34, 0xe1, 0x25, 0xf1, 0x17, 0x18, 0x19, 0x1a, 0x26, 0x27, 0x28, 0x29, 0x2a,
  0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49,
  0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66,
  0x67, 0x68, 0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x82,
  0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89, 0x8a, 0x92, 0x93, 0x94, 0x95, 0x96,
  0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9, 0xaa,
  0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5,
  0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9,
  0xda, 0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf2, 0xf3, 0xf4,
  0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa,
];

interface JpegHuffmanCode {
  code: number;
  length: number;
}

function buildJpegCodes(
  bits: readonly number[],
  values: readonly number[],
): Map<number, JpegHuffmanCode> {
  const codes = new Map<number, JpegHuffmanCode>();
  let code = 0;
  let index = 0;
  for (let length = 1; length <= 16; length += 1) {
    const count = bits[length - 1] ?? 0;
    for (let i = 0; i < count; i += 1) {
      const symbol = values[index];
      index += 1;
      if (symbol === undefined) break;
      codes.set(symbol, { code, length });
      code += 1;
    }
    code <<= 1;
  }
  return codes;
}

const JPEG_DC_LUMA_CODES = buildJpegCodes(STD_DC_LUMA_BITS, STD_DC_LUMA_VALUES);
const JPEG_DC_CHROMA_CODES = buildJpegCodes(STD_DC_CHROMA_BITS, STD_DC_CHROMA_VALUES);
const JPEG_AC_LUMA_CODES = buildJpegCodes(STD_AC_LUMA_BITS, STD_AC_LUMA_VALUES);
const JPEG_AC_CHROMA_CODES = buildJpegCodes(STD_AC_CHROMA_BITS, STD_AC_CHROMA_VALUES);

/** Annex K quantization tables scaled for a quality of 1..100. */
function scaleQuantTable(base: readonly number[], quality: number): Int32Array {
  const clamped = Math.max(1, Math.min(100, Math.round(quality)));
  const scale = clamped < 50 ? Math.floor(5000 / clamped) : 200 - clamped * 2;
  const table = new Int32Array(64);
  for (let i = 0; i < 64; i += 1) {
    const value = Math.floor((base[i]! * scale + 50) / 100);
    table[i] = Math.max(1, Math.min(255, value));
  }
  return table;
}

function magnitudeCategory(value: number): number {
  let magnitude = Math.abs(value);
  let category = 0;
  while (magnitude > 0) {
    category += 1;
    magnitude >>= 1;
  }
  return category;
}

class JpegBitWriter {
  private readonly sink = new ByteSink();
  private buffer = 0;
  private bitCount = 0;

  writeBits(value: number, count: number): void {
    for (let i = count - 1; i >= 0; i -= 1) {
      this.buffer = (this.buffer << 1) | ((value >> i) & 1);
      this.bitCount += 1;
      if (this.bitCount === 8) this.flush();
    }
  }

  private flush(): void {
    const byte = this.buffer & 0xff;
    this.sink.push(byte);
    // Byte stuffing: a literal FF inside entropy data is written as FF 00.
    if (byte === 0xff) this.sink.push(0x00);
    this.buffer = 0;
    this.bitCount = 0;
  }

  finish(): Uint8Array {
    while (this.bitCount !== 0) {
      this.buffer = (this.buffer << 1) | 1;
      this.bitCount += 1;
      if (this.bitCount === 8) this.flush();
    }
    return this.sink.toUint8Array().slice();
  }
}

/** Forward DCT + quantization of one 8x8 sample block into zig-zag order. */
function encodeJpegBlock(
  plane: Float32Array,
  planeWidth: number,
  blockX: number,
  blockY: number,
  quant: Int32Array,
  out: Int32Array,
): void {
  const scratch = DCT_SCRATCH;
  for (let y = 0; y < 8; y += 1) {
    const rowBase = (blockY * 8 + y) * planeWidth + blockX * 8;
    for (let u = 0; u < 8; u += 1) {
      let sum = 0;
      for (let x = 0; x < 8; x += 1) {
        sum += plane[rowBase + x]! * DCT_BASIS[u * 8 + x]!;
      }
      scratch[y * 8 + u] = sum;
    }
  }
  for (let v = 0; v < 8; v += 1) {
    for (let u = 0; u < 8; u += 1) {
      let sum = 0;
      for (let y = 0; y < 8; y += 1) {
        sum += DCT_BASIS[v * 8 + y]! * scratch[y * 8 + u]!;
      }
      const natural = v * 8 + u;
      const step = quant[natural]!;
      out[natural] = Math.round(sum / 4 / step);
    }
  }
}

function writeJpegSegment(sink: ByteSink, marker: number, payload: Uint8Array): void {
  sink.push(0xff);
  sink.push(marker);
  sink.pushU16(payload.length + 2);
  sink.pushAll(payload);
}

/**
 * Encodes RGBA8 as a baseline 4:2:0 JPEG, compositing any alpha over white the
 * way Magpie's Go bridge does before it writes the pixels again.
 */
export function encodeJpegRgba(
  width: number,
  height: number,
  rgba: Uint8Array,
  quality = 85,
): Uint8Array {
  const lumaQuant = scaleQuantTable(STD_LUMA_QUANT, quality);
  const chromaQuant = scaleQuantTable(STD_CHROMA_QUANT, quality);

  // 4:2:0 needs the luma plane on a 16-pixel and the chroma on an 8-pixel grid.
  const paddedWidth = Math.max(16, Math.ceil(width / 16) * 16);
  const paddedHeight = Math.max(16, Math.ceil(height / 16) * 16);
  const chromaWidth = paddedWidth / 2;
  const chromaHeight = paddedHeight / 2;

  const luma = new Float32Array(paddedWidth * paddedHeight);
  const cb = new Float32Array(chromaWidth * chromaHeight);
  const cr = new Float32Array(chromaWidth * chromaHeight);

  const sample = (x: number, y: number, channel: number): number => {
    const cx = Math.min(x, width - 1);
    const cy = Math.min(y, height - 1);
    const index = (cy * width + cx) * 4;
    const alpha = rgba[index + 3]!;
    const value = rgba[index + channel]!;
    // Composite over white so a transparent pixel never turns black in JPEG.
    return Math.round((value * alpha + 255 * (255 - alpha)) / 255);
  };

  for (let y = 0; y < paddedHeight; y += 1) {
    for (let x = 0; x < paddedWidth; x += 1) {
      const r = sample(x, y, 0);
      const g = sample(x, y, 1);
      const b = sample(x, y, 2);
      luma[y * paddedWidth + x] = 0.299 * r + 0.587 * g + 0.114 * b - 128;
    }
  }
  for (let y = 0; y < chromaHeight; y += 1) {
    for (let x = 0; x < chromaWidth; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let dy = 0; dy < 2; dy += 1) {
        for (let dx = 0; dx < 2; dx += 1) {
          r += sample(x * 2 + dx, y * 2 + dy, 0);
          g += sample(x * 2 + dx, y * 2 + dy, 1);
          b += sample(x * 2 + dx, y * 2 + dy, 2);
        }
      }
      r /= 4;
      g /= 4;
      b /= 4;
      cb[y * chromaWidth + x] = -0.168736 * r - 0.331264 * g + 0.5 * b;
      cr[y * chromaWidth + x] = 0.5 * r - 0.418688 * g - 0.081312 * b;
    }
  }

  const sink = new ByteSink();
  sink.push(0xff);
  sink.push(0xd8); // SOI
  // APP0 / JFIF so the file is unambiguous.
  writeJpegSegment(
    sink,
    0xe0,
    Uint8Array.from([0x4a, 0x46, 0x49, 0x46, 0x00, 1, 1, 0, 0, 1, 0, 1, 0, 0]),
  );

  const writeQuant = (id: number, table: Int32Array): void => {
    const payload = new Uint8Array(65);
    payload[0] = id;
    for (let i = 0; i < 64; i += 1) payload[i + 1] = table[ZIGZAG[i]!]!;
    writeJpegSegment(sink, 0xdb, payload);
  };
  writeQuant(0, lumaQuant);
  writeQuant(1, chromaQuant);

  // SOF0: 8-bit, 3 components, luma 2x2 sampling, chroma 1x1.
  writeJpegSegment(
    sink,
    0xc0,
    Uint8Array.from([
      8,
      (height >> 8) & 0xff,
      height & 0xff,
      (width >> 8) & 0xff,
      width & 0xff,
      3,
      1,
      0x22,
      0,
      2,
      0x11,
      1,
      3,
      0x11,
      1,
    ]),
  );

  const writeHuffman = (
    classAndId: number,
    bits: readonly number[],
    values: readonly number[],
  ): void => {
    const payload = new Uint8Array(1 + 16 + values.length);
    payload[0] = classAndId;
    for (let i = 0; i < 16; i += 1) payload[1 + i] = bits[i] ?? 0;
    for (let i = 0; i < values.length; i += 1) payload[17 + i] = values[i]!;
    writeJpegSegment(sink, 0xc4, payload);
  };
  writeHuffman(0x00, STD_DC_LUMA_BITS, STD_DC_LUMA_VALUES);
  writeHuffman(0x10, STD_AC_LUMA_BITS, STD_AC_LUMA_VALUES);
  writeHuffman(0x01, STD_DC_CHROMA_BITS, STD_DC_CHROMA_VALUES);
  writeHuffman(0x11, STD_AC_CHROMA_BITS, STD_AC_CHROMA_VALUES);

  // SOS: luma uses tables 0, chroma tables 1; full spectral selection.
  writeJpegSegment(
    sink,
    0xda,
    Uint8Array.from([3, 1, 0x00, 2, 0x11, 3, 0x11, 0, 63, 0]),
  );

  const writer = new JpegBitWriter();
  const quantized = new Int32Array(64);
  let dcLuma = 0;
  let dcCb = 0;
  let dcCr = 0;

  const emit = (
    dcCodes: Map<number, JpegHuffmanCode>,
    acCodes: Map<number, JpegHuffmanCode>,
    previous: number,
  ): number => {
    const dcValue = quantized[0]!;
    const difference = dcValue - previous;
    const dcCategory = magnitudeCategory(difference);
    const dcCode = dcCodes.get(dcCategory);
    if (dcCode !== undefined) {
      writer.writeBits(dcCode.code, dcCode.length);
      if (dcCategory > 0) {
        writer.writeBits(
          difference < 0 ? difference + (1 << dcCategory) - 1 : difference,
          dcCategory,
        );
      }
    }
    let run = 0;
    for (let k = 1; k < 64; k += 1) {
      const value = quantized[ZIGZAG[k]!]!;
      if (value === 0) {
        run += 1;
        continue;
      }
      while (run > 15) {
        const zrl = acCodes.get(0xf0);
        if (zrl !== undefined) writer.writeBits(zrl.code, zrl.length);
        run -= 16;
      }
      const category = magnitudeCategory(value);
      const code = acCodes.get((run << 4) | category);
      if (code !== undefined) {
        writer.writeBits(code.code, code.length);
        writer.writeBits(
          value < 0 ? value + (1 << category) - 1 : value,
          category,
        );
      }
      run = 0;
    }
    if (run > 0) {
      const eob = acCodes.get(0x00);
      if (eob !== undefined) writer.writeBits(eob.code, eob.length);
    }
    return dcValue;
  };

  const mcusX = paddedWidth / 16;
  const mcusY = paddedHeight / 16;
  for (let my = 0; my < mcusY; my += 1) {
    for (let mx = 0; mx < mcusX; mx += 1) {
      for (let v = 0; v < 2; v += 1) {
        for (let h = 0; h < 2; h += 1) {
          encodeJpegBlock(
            luma,
            paddedWidth,
            mx * 2 + h,
            my * 2 + v,
            lumaQuant,
            quantized,
          );
          dcLuma = emit(JPEG_DC_LUMA_CODES, JPEG_AC_LUMA_CODES, dcLuma);
        }
      }
      encodeJpegBlock(cb, chromaWidth, mx, my, chromaQuant, quantized);
      dcCb = emit(JPEG_DC_CHROMA_CODES, JPEG_AC_CHROMA_CODES, dcCb);
      encodeJpegBlock(cr, chromaWidth, mx, my, chromaQuant, quantized);
      dcCr = emit(JPEG_DC_CHROMA_CODES, JPEG_AC_CHROMA_CODES, dcCr);
    }
  }

  sink.pushAll(writer.finish());
  sink.push(0xff);
  sink.push(0xd9); // EOI
  return sink.toUint8Array().slice();
}

// ---------------------------------------------------------------------------
// Fitting
// ---------------------------------------------------------------------------

interface FittedImage {
  mediaType: string;
  data: string;
  /** True when the original bytes are handed back unchanged. */
  passthrough: boolean;
}

const fittedCache = new Map<string, FittedImage>();
let fittedCacheBytes = 0;

function cacheKey(mediaType: string, data: string): string {
  return createHash("sha256").update(`${mediaType};${data}`, "utf8").digest("hex");
}

function rememberFitted(key: string, entry: FittedImage): FittedImage {
  const previous = fittedCache.get(key);
  if (previous !== undefined) fittedCacheBytes -= previous.data.length;
  fittedCache.delete(key);
  fittedCache.set(key, entry);
  fittedCacheBytes += entry.data.length;
  while (
    fittedCache.size > FITTED_CACHE_MAX_ENTRIES ||
    fittedCacheBytes > FITTED_CACHE_MAX_BYTES
  ) {
    const oldest = fittedCache.keys().next().value;
    if (oldest === undefined) break;
    const evicted = fittedCache.get(oldest);
    fittedCache.delete(oldest);
    if (evicted !== undefined) fittedCacheBytes -= evicted.data.length;
  }
  return entry;
}

function base64EncodedLength(bytes: number): number {
  return Math.ceil(bytes / 3) * 4;
}

/**
 * Returns the media type and base64 of an image that is safe to hand upstream.
 *
 * An image that already fits, and any image whose pixels cannot be read, comes
 * back byte for byte. Otherwise it is scaled to at most `MAX_INLINE_IMAGE_SIDE`
 * and re-encoded (JPEG staying JPEG at quality 85, everything else as PNG), with
 * a progressively lower-quality JPEG as the last resort before giving up.
 */
export function fitInlineImage(
  mediaType: string,
  data: string,
): { mediaType: string; data: string } {
  try {
    return fitInlineImageOrPassthrough(mediaType, data);
  } catch {
    // Fitting is best effort on untrusted bytes: a corrupt or adversarial image
    // must reach the caller byte for byte, never as an exception.
    return { mediaType, data };
  }
}

function fitInlineImageOrPassthrough(
  mediaType: string,
  data: string,
): { mediaType: string; data: string } {
  const clean = data.replace(/\s+/g, "");
  const raw = decodeBase64(clean);
  if (raw === null) return { mediaType, data };

  const dimensions = readImageDimensions(raw);
  if (dimensions === null) return { mediaType, data };

  if (
    dimensions.width <= MAX_INLINE_IMAGE_SIDE &&
    dimensions.height <= MAX_INLINE_IMAGE_SIDE &&
    clean.length <= MAX_INLINE_IMAGE_BASE64_BYTES
  ) {
    return { mediaType, data };
  }

  const key = cacheKey(mediaType, clean);
  const cached = fittedCache.get(key);
  if (cached !== undefined) {
    fittedCache.delete(key);
    fittedCache.set(key, cached);
    return cached.passthrough ? { mediaType, data } : { mediaType: cached.mediaType, data: cached.data };
  }

  const passthrough = (): { mediaType: string; data: string } => {
    rememberFitted(key, { mediaType, data: "", passthrough: true });
    return { mediaType, data };
  };

  if (raw.length + dimensions.width * dimensions.height * 4 > MAX_DECODE_HOLD_BYTES) {
    return passthrough();
  }

  const decoded = decodeCheckedImageRgba(raw, dimensions);
  if (decoded === null) return passthrough();

  const longest = Math.max(decoded.width, decoded.height);
  const scale = Math.min(MAX_INLINE_IMAGE_SIDE / longest, 1);
  const targetWidth = Math.max(1, Math.round(decoded.width * scale));
  const targetHeight = Math.max(1, Math.round(decoded.height * scale));
  const resized =
    scale < 1
      ? resizeRgba(decoded, targetWidth, targetHeight)
      : decoded;

  const fits = (bytes: Uint8Array): boolean =>
    base64EncodedLength(bytes.length) <= MAX_INLINE_IMAGE_BASE64_BYTES;

  const accept = (type: string, bytes: Uint8Array): { mediaType: string; data: string } => {
    const encoded = Buffer.from(bytes).toString("base64");
    rememberFitted(key, { mediaType: type, data: encoded, passthrough: false });
    return { mediaType: type, data: encoded };
  };

  if (dimensions.format === "jpeg") {
    const jpeg = encodeJpegRgba(resized.width, resized.height, resized.rgba, 85);
    if (fits(jpeg)) return accept("image/jpeg", jpeg);
  } else {
    const png = encodePngRgba(resized.width, resized.height, resized.rgba);
    if (fits(png)) return accept("image/png", png);
  }

  // Still over the cap (a very noisy photo, or an image that does not compress):
  // JPEG on white at a lower quality, exactly like the Go bridge's fallback.
  for (const quality of [75, 60, 40]) {
    const jpeg = encodeJpegRgba(resized.width, resized.height, resized.rgba, quality);
    if (fits(jpeg)) return accept("image/jpeg", jpeg);
  }

  return passthrough();
}

function decodeBase64(data: string): Uint8Array | null {
  if (data === "") return null;
  try {
    const buffer = Buffer.from(data, "base64");
    if (buffer.length === 0) return null;
    return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  } catch {
    return null;
  }
}

/** Test/observability hook: how many fitted images are memoized right now. */
export function getFittedImageCacheSize(): number {
  return fittedCache.size;
}
