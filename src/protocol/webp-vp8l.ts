/**
 * Zero-dependency WebP VP8L lossless bitstream decoder and shared decode budget.
 */

export const DEFAULT_MAX_DECODE_HOLD_BYTES = 256 * 1024 * 1024;
const MAX_VP8L_DEPTH = 4;
const ROOT_BITS = 8;
const MAX_HUFFMAN_BITS = 15;

export class DecodeBudget {
  bytesUsed: number;
  stepsUsed = 0;
  readonly maxHoldBytes: number;
  readonly maxSteps: number;

  constructor(initialBytes: number, maxHoldBytes: number) {
    this.bytesUsed = initialBytes;
    this.maxHoldBytes = maxHoldBytes;
    this.maxSteps = Math.min(300_000_000, Math.max(2_000_000, maxHoldBytes * 4));
  }

  step(count = 1): boolean {
    this.stepsUsed += count;
    return this.stepsUsed <= this.maxSteps;
  }

  reserve(byteLength: number): boolean {
    if (!Number.isSafeInteger(byteLength) || byteLength < 0) return false;
    if (this.bytesUsed + byteLength > this.maxHoldBytes) return false;
    this.bytesUsed += byteLength;
    return true;
  }

  allocU8(length: number): Uint8Array | null {
    return this.reserve(length) ? new Uint8Array(length) : null;
  }

  allocU16(length: number): Uint16Array | null {
    return this.reserve(length * 2) ? new Uint16Array(length) : null;
  }

  allocI32(length: number): Int32Array | null {
    return this.reserve(length * 4) ? new Int32Array(length) : null;
  }

  allocU32(length: number): Uint32Array | null {
    return this.reserve(length * 4) ? new Uint32Array(length) : null;
  }
}

class Vp8lBitReader {
  private pos = 0;
  private bitBuf = 0;
  private bitCount = 0;
  eof = false;

  constructor(private readonly data: Uint8Array) {}

  private fill(): void {
    while (this.bitCount <= 24 && this.pos < this.data.length) {
      this.bitBuf = (this.bitBuf | (this.data[this.pos]! << this.bitCount)) >>> 0;
      this.pos += 1;
      this.bitCount += 8;
    }
  }

  readBits(n: number): number {
    if (n === 0) return 0;
    this.fill();
    if (this.bitCount < n) {
      this.eof = true;
      return 0;
    }
    const val = (this.bitBuf & ((1 << n) - 1)) >>> 0;
    this.bitBuf >>>= n;
    this.bitCount -= n;
    return val;
  }

  peek15(): number {
    this.fill();
    return this.bitBuf & 0x7fff;
  }

  consume(n: number): boolean {
    if (this.bitCount < n) {
      this.eof = true;
      return false;
    }
    this.bitBuf >>>= n;
    this.bitCount -= n;
    return true;
  }
}

interface HuffmanTree {
  singleSymbol: number;
  /** Positive entry: `(bits << 16) | sym`. Negative entry: `-((subOffset << 4) | subBits)`. */
  table: Int32Array | null;
}

const CODE_LENGTH_ORDER: readonly number[] = [
  17, 18, 0, 1, 2, 3, 4, 5, 16, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
];

const PLANE_TO_COORDS: readonly number[] = [
  0, 1, 1, 0, 1, 1, -1, 1, 0, 2, 2, 0, 1, 2, -1, 2, 2, 1, -2, 1, 2, 2, -2, 2,
  0, 3, 3, 0, 1, 3, -1, 3, 3, 1, -3, 1, 2, 3, -2, 3, 3, 2, -3, 2, 0, 4, 4, 0,
  1, 4, -1, 4, 4, 1, -4, 1, 3, 3, -3, 3, 2, 4, -2, 4, 4, 2, -4, 2, 0, 5, 3, 4,
  -3, 4, 4, 3, -4, 3, 5, 0, 1, 5, -1, 5, 5, 1, -5, 1, 2, 5, -2, 5, 5, 2, -5, 2,
  4, 4, -4, 4, 3, 5, -3, 5, 5, 3, -5, 3, 0, 6, 6, 0, 1, 6, -1, 6, 6, 1, -6, 1,
  2, 6, -2, 6, 6, 2, -6, 2, 4, 5, -4, 5, 5, 4, -5, 4, 3, 6, -3, 6, 6, 3, -6, 3,
  0, 7, 7, 0, 1, 7, -1, 7, 5, 5, -5, 5, 7, 1, -7, 1, 4, 6, -4, 6, 6, 4, -6, 4,
  2, 7, -2, 7, 7, 2, -7, 2, 3, 7, -3, 7, 7, 3, -7, 3, 5, 6, -5, 6, 6, 5, -6, 5,
  8, 0, 4, 7, -4, 7, 7, 4, -7, 4, 8, 1, 8, 2, 6, 6, -6, 6, 8, 3, 5, 7, -5, 7,
  7, 5, -7, 5, 8, 4, 6, 7, -6, 7, 7, 6, -7, 6, 8, 5, 7, 7, -7, 7, 8, 6, 8, 7,
];

function reverseBits(code: number, len: number): number {
  let out = 0;
  let v = code;
  for (let i = 0; i < len; i += 1) {
    out = (out << 1) | (v & 1);
    v >>>= 1;
  }
  return out;
}

function buildHuffmanTree(
  codeLengths: Uint8Array,
  maxBits: number,
  budget: DecodeBudget,
): HuffmanTree | null {
  if (!budget.step(codeLengths.length)) return null;
  const blCount = new Int32Array(maxBits + 1);
  let countNonZero = 0;
  let singleSymbol = -1;
  let maxLen = 0;

  for (let sym = 0; sym < codeLengths.length; sym += 1) {
    const len = codeLengths[sym]!;
    if (len === 0) continue;
    if (len > maxBits) return null;
    blCount[len]! += 1;
    countNonZero += 1;
    singleSymbol = sym;
    if (len > maxLen) maxLen = len;
  }

  if (countNonZero === 0) return null;
  if (countNonZero === 1) return { singleSymbol, table: null };

  let left = 1;
  for (let bits = 1; bits <= maxLen; bits += 1) {
    left = (left << 1) - blCount[bits]!;
    if (left < 0) return null;
  }
  if (left !== 0) return null;

  const nextCode = new Int32Array(maxBits + 1);
  let code = 0;
  for (let bits = 1; bits <= maxLen; bits += 1) {
    code = (code + blCount[bits - 1]!) << 1;
    nextCode[bits] = code;
  }

  const rootSize = 1 << ROOT_BITS;
  const subMaxLen = maxLen > ROOT_BITS ? new Uint8Array(rootSize) : null;
  const symRev = new Int32Array(codeLengths.length);

  for (let sym = 0; sym < codeLengths.length; sym += 1) {
    const len = codeLengths[sym]!;
    if (len === 0) continue;
    const rev = reverseBits(nextCode[len]!, len);
    nextCode[len]! += 1;
    symRev[sym] = rev;
    if (len > ROOT_BITS && subMaxLen !== null) {
      const prefix = rev & (rootSize - 1);
      const extra = len - ROOT_BITS;
      if (extra > subMaxLen[prefix]!) subMaxLen[prefix] = extra;
    }
  }

  let totalSize = rootSize;
  const subOffsets = subMaxLen !== null ? new Int32Array(rootSize) : null;
  if (subMaxLen !== null && subOffsets !== null) {
    for (let p = 0; p < rootSize; p += 1) {
      const subBits = subMaxLen[p]!;
      if (subBits > 0) {
        subOffsets[p] = totalSize;
        totalSize += 1 << subBits;
      }
    }
  }

  const table = budget.allocI32(totalSize);
  if (table === null) return null;

  if (subMaxLen !== null && subOffsets !== null) {
    for (let p = 0; p < rootSize; p += 1) {
      const subBits = subMaxLen[p]!;
      if (subBits > 0) table[p] = -((subOffsets[p]! << 4) | subBits);
    }
  }

  for (let sym = 0; sym < codeLengths.length; sym += 1) {
    const len = codeLengths[sym]!;
    if (len === 0) continue;
    const rev = symRev[sym]!;
    if (len <= ROOT_BITS) {
      const entry = (len << 16) | sym;
      const step = 1 << len;
      for (let idx = rev; idx < rootSize; idx += step) table[idx] = entry;
    } else {
      const prefix = rev & (rootSize - 1);
      const subBits = subMaxLen![prefix]!;
      const subBase = subOffsets![prefix]!;
      const subLen = len - ROOT_BITS;
      const entry = (subLen << 16) | sym;
      const step = 1 << subLen;
      const subSize = 1 << subBits;
      for (let idx = rev >>> ROOT_BITS; idx < subSize; idx += step) {
        table[subBase + idx] = entry;
      }
    }
  }

  return { singleSymbol: -1, table };
}

function readSymbol(br: Vp8lBitReader, tree: HuffmanTree): number {
  if (tree.table === null) return tree.singleSymbol;
  const bits = br.peek15();
  let entry = tree.table[bits & 0xff]!;
  if (entry > 0) {
    return br.consume(entry >>> 16) ? entry & 0xffff : -1;
  }
  if (entry === 0) return -1;
  const packed = -entry;
  const subOffset = packed >>> 4;
  const subBits = packed & 0x0f;
  entry = tree.table[subOffset + ((bits >>> ROOT_BITS) & ((1 << subBits) - 1))]!;
  if (entry <= 0) return -1;
  return br.consume(ROOT_BITS + (entry >>> 16)) ? entry & 0xffff : -1;
}

function readHuffmanTree(
  br: Vp8lBitReader,
  alphabetSize: number,
  budget: DecodeBudget,
): HuffmanTree | null {
  if (!budget.reserve(32)) return null;
  const isSimple = br.readBits(1);
  if (br.eof) return null;

  if (isSimple === 1) {
    const numSymbols = br.readBits(1) + 1;
    const isFirst8Bits = br.readBits(1);
    const sym0 = br.readBits(isFirst8Bits === 1 ? 8 : 1);
    if (br.eof || sym0 >= alphabetSize) return null;
    if (numSymbols === 1) return { singleSymbol: sym0, table: null };
    const sym1 = br.readBits(8);
    if (br.eof || sym1 >= alphabetSize || sym1 === sym0) return null;
    const lengths = new Uint8Array(alphabetSize);
    lengths[sym0] = 1;
    lengths[sym1] = 1;
    return buildHuffmanTree(lengths, 1, budget);
  }

  const numCodeLengths = br.readBits(4) + 4;
  const clLengths = new Uint8Array(19);
  for (let i = 0; i < numCodeLengths; i += 1) {
    clLengths[CODE_LENGTH_ORDER[i]!] = br.readBits(3);
  }
  if (br.eof) return null;
  const clTree = buildHuffmanTree(clLengths, 7, budget);
  if (clTree === null) return null;

  let maxSymbol = alphabetSize;
  if (br.readBits(1) === 1) {
    const lengthNbits = 2 + 2 * br.readBits(3);
    maxSymbol = 2 + br.readBits(lengthNbits);
    if (br.eof || maxSymbol > alphabetSize) return null;
  }

  const codeLengths = new Uint8Array(alphabetSize);
  let prevCodeLen = 8;
  let symbol = 0;
  while (symbol < alphabetSize) {
    if (maxSymbol === 0) break;
    maxSymbol -= 1;
    if (!budget.step()) return null;
    const codeLen = readSymbol(br, clTree);
    if (codeLen < 0 || br.eof) return null;
    if (codeLen < 16) {
      codeLengths[symbol] = codeLen;
      symbol += 1;
      if (codeLen !== 0) prevCodeLen = codeLen;
    } else {
      let repeat: number;
      let fill: number;
      if (codeLen === 16) {
        repeat = 3 + br.readBits(2);
        fill = prevCodeLen;
      } else if (codeLen === 17) {
        repeat = 3 + br.readBits(3);
        fill = 0;
      } else {
        repeat = 11 + br.readBits(7);
        fill = 0;
      }
      if (br.eof || symbol + repeat > alphabetSize) return null;
      if (fill !== 0) codeLengths.fill(fill, symbol, symbol + repeat);
      symbol += repeat;
    }
  }
  return buildHuffmanTree(codeLengths, MAX_HUFFMAN_BITS, budget);
}

function subSampleSize(size: number, samplingBits: number): number {
  return (size + (1 << samplingBits) - 1) >>> samplingBits;
}

function decodePrefixValue(br: Vp8lBitReader, prefixCode: number): number {
  if (prefixCode < 4) return prefixCode + 1;
  const extraBits = (prefixCode - 2) >>> 1;
  const offset = (2 + (prefixCode & 1)) << extraBits;
  return offset + br.readBits(extraBits) + 1;
}

function addPixels(a: number, b: number): number {
  const alpha = (((a >>> 24) + (b >>> 24)) & 0xff) << 24;
  const red = ((((a >>> 16) & 0xff) + ((b >>> 16) & 0xff)) & 0xff) << 16;
  const green = ((((a >>> 8) & 0xff) + ((b >>> 8) & 0xff)) & 0xff) << 8;
  const blue = ((a & 0xff) + (b & 0xff)) & 0xff;
  return (alpha | red | green | blue) >>> 0;
}

function average2(a0: number, a1: number): number {
  return (((((a0 ^ a1) & 0xfefefefe) >>> 1) + ((a0 & a1) >>> 0)) >>> 0);
}

function clamp255(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

function clampAddSubtractFull(a: number, b: number, c: number): number {
  const pa = clamp255((a >>> 24) + (b >>> 24) - (c >>> 24));
  const pr = clamp255(((a >>> 16) & 0xff) + ((b >>> 16) & 0xff) - ((c >>> 16) & 0xff));
  const pg = clamp255(((a >>> 8) & 0xff) + ((b >>> 8) & 0xff) - ((c >>> 8) & 0xff));
  const pb = clamp255((a & 0xff) + (b & 0xff) - (c & 0xff));
  return ((pa << 24) | (pr << 16) | (pg << 8) | pb) >>> 0;
}

function halfDiff(a: number, b: number): number {
  return clamp255(a + (((a - b) / 2) | 0));
}

function clampAddSubtractHalf(a: number, b: number): number {
  const pa = halfDiff(a >>> 24, b >>> 24);
  const pr = halfDiff((a >>> 16) & 0xff, (b >>> 16) & 0xff);
  const pg = halfDiff((a >>> 8) & 0xff, (b >>> 8) & 0xff);
  const pb = halfDiff(a & 0xff, b & 0xff);
  return ((pa << 24) | (pr << 16) | (pg << 8) | pb) >>> 0;
}

function selectPredictor(l: number, t: number, tl: number): number {
  const la = l >>> 24, lr = (l >>> 16) & 0xff, lg = (l >>> 8) & 0xff, lb = l & 0xff;
  const ta = t >>> 24, tr = (t >>> 16) & 0xff, tg = (t >>> 8) & 0xff, tb = t & 0xff;
  const tla = tl >>> 24, tlr = (tl >>> 16) & 0xff, tlg = (tl >>> 8) & 0xff, tlb = tl & 0xff;
  const pL = Math.abs(ta - tla) + Math.abs(tr - tlr) + Math.abs(tg - tlg) + Math.abs(tb - tlb);
  const pT = Math.abs(la - tla) + Math.abs(lr - tlr) + Math.abs(lg - tlg) + Math.abs(lb - tlb);
  return pL < pT ? l : t;
}

function predictPixel(mode: number, l: number, t: number, tr: number, tl: number): number {
  switch (mode) {
    case 0: return 0xff000000;
    case 1: return l;
    case 2: return t;
    case 3: return tr;
    case 4: return tl;
    case 5: return average2(average2(l, tr), t);
    case 6: return average2(l, tl);
    case 7: return average2(l, t);
    case 8: return average2(tl, t);
    case 9: return average2(t, tr);
    case 10: return average2(average2(l, tl), average2(t, tr));
    case 11: return selectPredictor(l, t, tl);
    case 12: return clampAddSubtractFull(l, t, tl);
    case 13: return clampAddSubtractHalf(average2(l, t), tl);
    default: return 0xff000000;
  }
}

function colorTransformDelta(t: number, c: number): number {
  return (((t << 24) >> 24) * ((c << 24) >> 24)) >> 5;
}

type Vp8lTransform =
  | { type: 0; sizeBits: number; subW: number; width: number; data: Uint32Array }
  | { type: 1; sizeBits: number; subW: number; width: number; data: Uint32Array }
  | { type: 2; width: number }
  | { type: 3; origWidth: number; packedWidth: number; widthBits: number; palette: Uint32Array };

function applyInverseTransforms(
  pixels: Uint32Array,
  height: number,
  transforms: readonly Vp8lTransform[],
  budget: DecodeBudget,
): boolean {
  for (let ti = transforms.length - 1; ti >= 0; ti -= 1) {
    const tr = transforms[ti]!;
    if (tr.type === 2) {
      const total = tr.width * height;
      if (!budget.step(total)) return false;
      for (let i = 0; i < total; i += 1) {
        const argb = pixels[i]!;
        const g = (argb >>> 8) & 0xff;
        const r = (((argb >>> 16) & 0xff) + g) & 0xff;
        const b = ((argb & 0xff) + g) & 0xff;
        pixels[i] = ((argb & 0xff00ff00) | (r << 16) | b) >>> 0;
      }
    } else if (tr.type === 1) {
      const w = tr.width;
      if (!budget.step(w * height)) return false;
      for (let y = 0; y < height; y += 1) {
        const subRow = (y >>> tr.sizeBits) * tr.subW;
        const rowOff = y * w;
        for (let x = 0; x < w; x += 1) {
          const m = tr.data[subRow + (x >>> tr.sizeBits)]!;
          const argb = pixels[rowOff + x]!;
          const g = (argb >>> 8) & 0xff;
          let r = (argb >>> 16) & 0xff;
          let b = argb & 0xff;
          r = (r + colorTransformDelta(m & 0xff, g)) & 0xff;
          b = (b + colorTransformDelta((m >>> 8) & 0xff, g) + colorTransformDelta((m >>> 16) & 0xff, r)) & 0xff;
          pixels[rowOff + x] = ((argb & 0xff00ff00) | (r << 16) | b) >>> 0;
        }
      }
    } else if (tr.type === 0) {
      const w = tr.width;
      if (!budget.step(w * height)) return false;
      pixels[0] = addPixels(pixels[0]!, 0xff000000);
      for (let x = 1; x < w; x += 1) {
        pixels[x] = addPixels(pixels[x]!, pixels[x - 1]!);
      }
      for (let y = 1; y < height; y += 1) {
        const rowOff = y * w;
        const prevOff = (y - 1) * w;
        pixels[rowOff] = addPixels(pixels[rowOff]!, pixels[prevOff]!);
        const subRow = (y >>> tr.sizeBits) * tr.subW;
        for (let x = 1; x < w; x += 1) {
          const mode = (tr.data[subRow + (x >>> tr.sizeBits)]! >>> 8) & 0x0f;
          const pred = predictPixel(
            mode,
            pixels[rowOff + x - 1]!,
            pixels[prevOff + x]!,
            pixels[prevOff + x + 1]!,
            pixels[prevOff + x - 1]!,
          );
          pixels[rowOff + x] = addPixels(pixels[rowOff + x]!, pred);
        }
      }
    } else {
      const { origWidth, packedWidth, widthBits, palette } = tr;
      if (!budget.step(origWidth * height)) return false;
      const bitsPerPixel = 8 >>> widthBits;
      const indexMask = (1 << bitsPerPixel) - 1;
      const posMask = (1 << widthBits) - 1;
      for (let y = height - 1; y >= 0; y -= 1) {
        const srcRow = y * packedWidth;
        const dstRow = y * origWidth;
        for (let x = origWidth - 1; x >= 0; x -= 1) {
          const green = (pixels[srcRow + (x >>> widthBits)]! >>> 8) & 0xff;
          const idx = widthBits === 0 ? green : (green >>> ((x & posMask) * bitsPerPixel)) & indexMask;
          pixels[dstRow + x] = idx < palette.length ? palette[idx]! : 0;
        }
      }
    }
  }
  return true;
}

type HTreeGroup = readonly [HuffmanTree, HuffmanTree, HuffmanTree, HuffmanTree, HuffmanTree];

function decodeVp8lStream(
  br: Vp8lBitReader,
  initialWidth: number,
  height: number,
  isTopLevel: boolean,
  depth: number,
  budget: DecodeBudget,
): Uint32Array | null {
  if (depth > MAX_VP8L_DEPTH || initialWidth <= 0 || height <= 0) return null;
  if (!Number.isSafeInteger(initialWidth * height)) return null;

  const transforms: Vp8lTransform[] = [];
  let xsize = initialWidth;
  if (isTopLevel) {
    let seenMask = 0;
    while (br.readBits(1) === 1) {
      if (br.eof) return null;
      const type = br.readBits(2);
      if (br.eof || (seenMask & (1 << type)) !== 0) return null;
      seenMask |= 1 << type;
      if (type === 0 || type === 1) {
        const sizeBits = br.readBits(3) + 2;
        if (br.eof) return null;
        const subW = subSampleSize(xsize, sizeBits);
        const subH = subSampleSize(height, sizeBits);
        const data = decodeVp8lStream(br, subW, subH, false, depth + 1, budget);
        if (data === null) return null;
        transforms.push({ type, sizeBits, subW, width: xsize, data });
      } else if (type === 2) {
        transforms.push({ type: 2, width: xsize });
      } else {
        const colorTableSize = br.readBits(8) + 1;
        if (br.eof) return null;
        const palette = decodeVp8lStream(br, colorTableSize, 1, false, depth + 1, budget);
        if (palette === null) return null;
        for (let i = 1; i < colorTableSize; i += 1) {
          palette[i] = addPixels(palette[i]!, palette[i - 1]!);
        }
        const widthBits =
          colorTableSize <= 2 ? 3 : colorTableSize <= 4 ? 2 : colorTableSize <= 16 ? 1 : 0;
        const packedWidth = subSampleSize(xsize, widthBits);
        transforms.push({ type: 3, origWidth: xsize, packedWidth, widthBits, palette });
        xsize = packedWidth;
      }
    }
  }

  let colorCacheBits = 0;
  let colorCache: Uint32Array | null = null;
  if (br.readBits(1) === 1) {
    colorCacheBits = br.readBits(4);
    if (br.eof || colorCacheBits < 1 || colorCacheBits > 11) return null;
    colorCache = budget.allocU32(1 << colorCacheBits);
    if (colorCache === null) return null;
  }
  if (br.eof) return null;

  let huffmanBits = 0;
  let huffmanXSize = 0;
  let huffmanGroups: Uint16Array | null = null;
  let numHtreeGroups = 1;
  if (isTopLevel && br.readBits(1) === 1) {
    huffmanBits = br.readBits(3) + 2;
    if (br.eof) return null;
    huffmanXSize = subSampleSize(xsize, huffmanBits);
    const huffmanYSize = subSampleSize(height, huffmanBits);
    const meta = decodeVp8lStream(br, huffmanXSize, huffmanYSize, false, depth + 1, budget);
    if (meta === null) return null;
    huffmanGroups = budget.allocU16(meta.length);
    if (huffmanGroups === null) return null;
    let maxGroup = 0;
    for (let i = 0; i < meta.length; i += 1) {
      const g = (meta[i]! >>> 8) & 0xffff;
      huffmanGroups[i] = g;
      if (g > maxGroup) maxGroup = g;
    }
    numHtreeGroups = maxGroup + 1;
  }
  if (br.eof) return null;

  const greenAlphabet = 256 + 24 + (colorCacheBits > 0 ? 1 << colorCacheBits : 0);
  if (!budget.reserve(numHtreeGroups * 64)) return null;
  const groups: HTreeGroup[] = [];
  for (let i = 0; i < numHtreeGroups; i += 1) {
    if (!budget.step()) return null;
    const gTree = readHuffmanTree(br, greenAlphabet, budget);
    const rTree = gTree && readHuffmanTree(br, 256, budget);
    const bTree = rTree && readHuffmanTree(br, 256, budget);
    const aTree = bTree && readHuffmanTree(br, 256, budget);
    const dTree = aTree && readHuffmanTree(br, 40, budget);
    if (!gTree || !rTree || !bTree || !aTree || !dTree) return null;
    groups.push([gTree, rTree, bTree, aTree, dTree]);
  }

  const pixels = budget.allocU32(initialWidth * height);
  if (pixels === null) return null;

  const totalCoded = xsize * height;
  const hashShift = 32 - colorCacheBits;
  let pos = 0;
  while (pos < totalCoded) {
    if (!budget.step()) return null;
    let group = groups[0]!;
    if (huffmanGroups !== null) {
      const y = (pos / xsize) | 0;
      const x = pos - y * xsize;
      group = groups[huffmanGroups[(y >>> huffmanBits) * huffmanXSize + (x >>> huffmanBits)]!]!;
    }
    const code = readSymbol(br, group[0]);
    if (code < 0) return null;
    if (code < 256) {
      const r = readSymbol(br, group[1]);
      const b = readSymbol(br, group[2]);
      const a = readSymbol(br, group[3]);
      if ((r | b | a) < 0) return null;
      const argb = ((a << 24) | (r << 16) | (code << 8) | b) >>> 0;
      pixels[pos] = argb;
      if (colorCache !== null) colorCache[Math.imul(0x1e35a7bd, argb) >>> hashShift] = argb;
      pos += 1;
    } else if (code < 280) {
      const length = decodePrefixValue(br, code - 256);
      const distSym = readSymbol(br, group[4]);
      if (br.eof || distSym < 0) return null;
      const distCode = decodePrefixValue(br, distSym);
      if (br.eof) return null;
      let dist: number;
      if (distCode > 120) {
        dist = distCode - 120;
      } else {
        const ci = (distCode - 1) * 2;
        dist = PLANE_TO_COORDS[ci]! + PLANE_TO_COORDS[ci + 1]! * xsize;
        if (dist < 1) dist = 1;
      }
      if (pos < dist || pos + length > totalCoded || !budget.step(length)) return null;
      for (let k = 0; k < length; k += 1) {
        const v = pixels[pos - dist]!;
        pixels[pos] = v;
        if (colorCache !== null) colorCache[Math.imul(0x1e35a7bd, v) >>> hashShift] = v;
        pos += 1;
      }
    } else {
      const idx = code - 280;
      if (colorCache === null || idx >= colorCache.length) return null;
      pixels[pos] = colorCache[idx]!;
      pos += 1;
    }
  }

  if (transforms.length > 0 && !applyInverseTransforms(pixels, height, transforms, budget)) {
    return null;
  }
  return pixels;
}

export function decodeVp8lChunk(
  chunk: Uint8Array,
  budget: DecodeBudget,
): { width: number; height: number; rgba: Uint8Array } | null {
  if (chunk.length < 5 || chunk[0] !== 0x2f) return null;
  const hdr =
    (chunk[1]! | (chunk[2]! << 8) | (chunk[3]! << 16) | (chunk[4]! << 24)) >>> 0;
  const width = (hdr & 0x3fff) + 1;
  const height = ((hdr >>> 14) & 0x3fff) + 1;
  const version = (hdr >>> 29) & 0x07;
  if (version !== 0) return null;

  const totalPixels = width * height;
  if (!Number.isSafeInteger(totalPixels) || !Number.isSafeInteger(totalPixels * 4)) {
    return null;
  }

  const br = new Vp8lBitReader(chunk.subarray(5));
  const argb = decodeVp8lStream(br, width, height, true, 0, budget);
  if (argb === null) return null;

  const rgba = budget.allocU8(totalPixels * 4);
  if (rgba === null || !budget.step(totalPixels)) return null;
  for (let i = 0; i < totalPixels; i += 1) {
    const px = argb[i]!;
    const dst = i * 4;
    rgba[dst] = (px >>> 16) & 0xff;
    rgba[dst + 1] = (px >>> 8) & 0xff;
    rgba[dst + 2] = px & 0xff;
    rgba[dst + 3] = (px >>> 24) & 0xff;
  }
  return { width, height, rgba };
}

export function decodeVp8lHeaderlessAlpha(
  data: Uint8Array,
  width: number,
  height: number,
  budget: DecodeBudget,
): Uint8Array | null {
  const totalPixels = width * height;
  if (!Number.isSafeInteger(totalPixels)) return null;
  const br = new Vp8lBitReader(data);
  const argb = decodeVp8lStream(br, width, height, true, 0, budget);
  if (argb === null) return null;
  const alpha = budget.allocU8(totalPixels);
  if (alpha === null || !budget.step(totalPixels)) return null;
  for (let i = 0; i < totalPixels; i += 1) {
    alpha[i] = (argb[i]! >>> 8) & 0xff;
  }
  return alpha;
}
