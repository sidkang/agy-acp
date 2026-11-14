/**
 * Zero-dependency WebP still-image decoder (`VP8L`, `VP8 `, and `VP8X` + `ALPH`).
 *
 * Animated WebP (`VP8X` animation flag `0x02` or any `ANMF`/`ANIM` chunk) and any
 * truncated, malformed, or over-budget input return `null` without throwing so
 * callers pass the original bytes through untouched.
 */

import {
  DEFAULT_MAX_DECODE_HOLD_BYTES,
  DecodeBudget,
  decodeVp8lChunk,
  decodeVp8lHeaderlessAlpha,
} from "./webp-vp8l";
import { decodeVp8Chunk } from "./webp-vp8";

function readU16LE(buf: Uint8Array, off: number): number {
  return (buf[off]! | (buf[off + 1]! << 8)) & 0xffff;
}

function readU24LE(buf: Uint8Array, off: number): number {
  return (buf[off]! | (buf[off + 1]! << 8) | (buf[off + 2]! << 16)) & 0xffffff;
}

function readU32LE(buf: Uint8Array, off: number): number {
  return (
    (buf[off]! | (buf[off + 1]! << 8) | (buf[off + 2]! << 16) | (buf[off + 3]! << 24)) >>>
    0
  );
}

function matchesFourCC(buf: Uint8Array, off: number, cc: string): boolean {
  return (
    off + 4 <= buf.length &&
    buf[off] === cc.charCodeAt(0) &&
    buf[off + 1] === cc.charCodeAt(1) &&
    buf[off + 2] === cc.charCodeAt(2) &&
    buf[off + 3] === cc.charCodeAt(3)
  );
}

function clamp255(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

function decodeAlphaChunk(
  alph: Uint8Array,
  width: number,
  height: number,
  budget: DecodeBudget,
): Uint8Array | null {
  if (alph.length < 1) return null;
  const hdr = alph[0]!;
  if ((hdr >>> 6) !== 0) return null;
  const compression = hdr & 0x03;
  const filtering = (hdr >>> 2) & 0x03;
  const preprocessing = (hdr >>> 4) & 0x03;
  if (preprocessing > 1) return null;

  const totalPixels = width * height;
  if (!Number.isSafeInteger(totalPixels)) return null;
  const payload = alph.subarray(1);

  let plane: Uint8Array | null = null;
  if (compression === 0) {
    if (payload.length < totalPixels) return null;
    plane = budget.allocU8(totalPixels);
    if (plane === null) return null;
    plane.set(payload.subarray(0, totalPixels));
  } else if (compression === 1) {
    plane = decodeVp8lHeaderlessAlpha(payload, width, height, budget);
    if (plane === null) return null;
  } else {
    return null;
  }

  if (filtering !== 0) {
    if (!budget.step(totalPixels)) return null;
    for (let x = 1; x < width; x += 1) {
      plane[x] = (plane[x]! + plane[x - 1]!) & 0xff;
    }
    for (let y = 1; y < height; y += 1) {
      const row = y * width;
      const prev = (y - 1) * width;
      plane[row] = (plane[row]! + plane[prev]!) & 0xff;
      if (filtering === 1) {
        for (let x = 1; x < width; x += 1) {
          plane[row + x] = (plane[row + x]! + plane[row + x - 1]!) & 0xff;
        }
      } else if (filtering === 2) {
        for (let x = 1; x < width; x += 1) {
          plane[row + x] = (plane[row + x]! + plane[prev + x]!) & 0xff;
        }
      } else {
        for (let x = 1; x < width; x += 1) {
          const pred = clamp255(plane[row + x - 1]! + plane[prev + x]! - plane[prev + x - 1]!);
          plane[row + x] = (plane[row + x]! + pred) & 0xff;
        }
      }
    }
  }
  return plane;
}

/**
 * Decodes a still WebP container (`VP8L`, `VP8 `, or `VP8X` + optional `ALPH`)
 * into RGBA8. Never throws; returns `null` on animated, malformed, or over-budget input.
 */
export function decodeWebp(
  raw: Uint8Array,
  maxHoldBytes: number = DEFAULT_MAX_DECODE_HOLD_BYTES,
): { width: number; height: number; rgba: Uint8Array } | null {
  try {
    if (!Number.isFinite(maxHoldBytes) || maxHoldBytes < raw.length) return null;
    if (raw.length < 20 || !matchesFourCC(raw, 0, "RIFF") || !matchesFourCC(raw, 8, "WEBP")) {
      return null;
    }

    const riffSize = readU32LE(raw, 4);
    const riffEnd = 8 + riffSize;
    if (riffSize < 12 || riffEnd > raw.length) return null;

    const budget = new DecodeBudget(raw.length, maxHoldBytes);
    const firstChunkSize = readU32LE(raw, 16);
    const firstPayloadEnd = 20 + firstChunkSize;
    const firstNextOffset = firstPayloadEnd + (firstChunkSize & 1);
    if (firstPayloadEnd > riffEnd || firstNextOffset > riffEnd) return null;

    const validateSimpleTrailingChunks = (): boolean => {
      let tailOffset = firstNextOffset;
      while (tailOffset < riffEnd) {
        if (!budget.step() || tailOffset + 8 > riffEnd) return false;
        const tSize = readU32LE(raw, tailOffset + 4);
        const tEnd = tailOffset + 8 + tSize;
        const tNext = tEnd + (tSize & 1);
        if (tEnd > riffEnd || tNext > riffEnd) return false;
        if (
          matchesFourCC(raw, tailOffset, "ANMF") ||
          matchesFourCC(raw, tailOffset, "ANIM") ||
          matchesFourCC(raw, tailOffset, "VP8 ") ||
          matchesFourCC(raw, tailOffset, "VP8L") ||
          matchesFourCC(raw, tailOffset, "VP8X") ||
          matchesFourCC(raw, tailOffset, "ALPH")
        ) {
          return false;
        }
        tailOffset = tNext;
      }
      return tailOffset === riffEnd;
    };

    if (matchesFourCC(raw, 12, "VP8L")) {
      if (!validateSimpleTrailingChunks()) return null;
      const payload = raw.subarray(20, firstPayloadEnd);
      if (payload.length < 5 || payload[0] !== 0x2f) return null;
      const bits = readU32LE(payload, 1);
      const probedW = (bits & 0x3fff) + 1;
      const probedH = ((bits >>> 14) & 0x3fff) + 1;
      const decoded = decodeVp8lChunk(payload, budget);
      if (decoded === null || decoded.width !== probedW || decoded.height !== probedH) {
        return null;
      }
      return decoded;
    }

    if (matchesFourCC(raw, 12, "VP8 ")) {
      if (!validateSimpleTrailingChunks()) return null;
      const payload = raw.subarray(20, firstPayloadEnd);
      if (payload.length < 10 || payload[3] !== 0x9d || payload[4] !== 0x01 || payload[5] !== 0x2a) {
        return null;
      }
      const probedW = readU16LE(payload, 6) & 0x3fff;
      const probedH = readU16LE(payload, 8) & 0x3fff;
      const decoded = decodeVp8Chunk(payload, budget);
      if (decoded === null || decoded.width !== probedW || decoded.height !== probedH) {
        return null;
      }
      return decoded;
    }

    if (!matchesFourCC(raw, 12, "VP8X") || firstChunkSize !== 10 || riffEnd < 30) {
      return null;
    }
    const flags = raw[20]!;
    // Reject animated WebP (0x02) or non-zero reserved VP8X header bits/bytes.
    if ((flags & 0x02) !== 0 || (flags & 0xc1) !== 0 || readU24LE(raw, 21) !== 0) {
      return null;
    }
    const canvasWidth = readU24LE(raw, 24) + 1;
    const canvasHeight = readU24LE(raw, 27) + 1;
    if (!Number.isSafeInteger(canvasWidth * canvasHeight)) return null;

    let alphChunk: Uint8Array | null = null;
    let imageType: "VP8 " | "VP8L" | null = null;
    let imageChunk: Uint8Array | null = null;
    let offset = 30;

    while (offset < riffEnd) {
      if (!budget.step() || offset + 8 > riffEnd) return null;
      const cSize = readU32LE(raw, offset + 4);
      const cStart = offset + 8;
      const cEnd = cStart + cSize;
      const nextOffset = cEnd + (cSize & 1);
      if (cEnd > riffEnd || nextOffset > riffEnd) return null;

      if (
        matchesFourCC(raw, offset, "ANMF") ||
        matchesFourCC(raw, offset, "ANIM") ||
        matchesFourCC(raw, offset, "VP8X")
      ) {
        return null;
      }
      if (matchesFourCC(raw, offset, "ALPH")) {
        if (imageChunk !== null || alphChunk !== null) return null;
        alphChunk = raw.subarray(cStart, cEnd);
      } else if (matchesFourCC(raw, offset, "VP8L")) {
        if (imageChunk !== null) return null;
        imageType = "VP8L";
        imageChunk = raw.subarray(cStart, cEnd);
      } else if (matchesFourCC(raw, offset, "VP8 ")) {
        if (imageChunk !== null) return null;
        imageType = "VP8 ";
        imageChunk = raw.subarray(cStart, cEnd);
      }
      offset = nextOffset;
    }

    if (imageChunk === null || imageType === null) return null;

    if (imageType === "VP8L") {
      const decoded = decodeVp8lChunk(imageChunk, budget);
      if (decoded === null || decoded.width !== canvasWidth || decoded.height !== canvasHeight) {
        return null;
      }
      return decoded;
    }

    const decoded = decodeVp8Chunk(imageChunk, budget);
    if (decoded === null || decoded.width !== canvasWidth || decoded.height !== canvasHeight) {
      return null;
    }
    if ((flags & 0x10) !== 0 && alphChunk !== null) {
      const alphaPlane = decodeAlphaChunk(alphChunk, canvasWidth, canvasHeight, budget);
      if (alphaPlane === null) return null;
      const total = canvasWidth * canvasHeight;
      for (let i = 0; i < total; i += 1) {
        decoded.rgba[i * 4 + 3] = alphaPlane[i]!;
      }
    }
    return decoded;
  } catch {
    return null;
  }
}
