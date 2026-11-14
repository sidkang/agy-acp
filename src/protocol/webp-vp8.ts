/**
 * Zero-dependency WebP VP8 lossy keyframe decoder (RFC 6386).
 */

import type { DecodeBudget } from "./webp-vp8l";

const DC_QLOOKUP = new Int16Array([
  4, 5, 6, 7, 8, 9, 10, 10, 11, 12, 13, 14, 15, 16, 17, 17, 18, 19, 20, 20, 21, 21, 22, 22, 23, 23,
  24, 25, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 37, 38, 39, 40, 41, 42, 43, 44, 45,
  46, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 60, 61, 62, 63, 64, 65, 66, 67, 68,
  69, 70, 71, 72, 73, 74, 75, 76, 76, 77, 78, 79, 80, 81, 82, 83, 84, 85, 86, 87, 88, 89, 91, 93,
  95, 96, 98, 100, 101, 102, 104, 106, 108, 110, 112, 114, 116, 118, 122, 124, 126, 128, 130, 132,
  134, 136, 138, 140, 143, 145, 148, 151, 154, 157,
]);

const AC_QLOOKUP = new Int16Array([
  4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29,
  30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53,
  54, 55, 56, 57, 58, 60, 62, 64, 66, 68, 70, 72, 74, 76, 78, 80, 82, 84, 86, 88, 90, 92, 94, 96,
  98, 100, 102, 104, 106, 108, 110, 112, 114, 116, 119, 122, 125, 128, 131, 134, 137, 140, 143,
  146, 149, 152, 155, 158, 161, 164, 167, 170, 173, 177, 181, 185, 189, 193, 197, 201, 205, 209,
  213, 217, 221, 225, 229, 234, 239, 245, 249, 254, 259, 264, 269, 274, 279, 284,
]);

const ZIGZAG_4X4 = new Uint8Array([0, 1, 4, 8, 5, 2, 3, 6, 9, 12, 13, 10, 7, 11, 14, 15]);
const COEFF_BANDS = new Uint8Array([0, 1, 2, 3, 6, 4, 5, 6, 6, 6, 6, 6, 6, 6, 6, 7]);

const PCAT1: readonly number[] = [159];
const PCAT2: readonly number[] = [165, 145];
const PCAT3: readonly number[] = [173, 148, 140];
const PCAT4: readonly number[] = [176, 155, 140, 135];
const PCAT5: readonly number[] = [180, 157, 141, 134, 130];
const PCAT6: readonly number[] = [254, 254, 243, 230, 196, 177, 153, 140, 133, 130, 129];

const KF_YMODE_TREE: readonly number[] = [-4, 2, 4, 6, 0, -1, -2, -3];
const KF_YMODE_PROBS: readonly number[] = [145, 156, 163, 128];
const UV_MODE_TREE: readonly number[] = [0, 2, -1, 4, -2, -3];
const KF_UV_MODE_PROBS: readonly number[] = [142, 114, 183];
const BMODE_TREE: readonly number[] = [0, 2, -1, 4, -2, 6, 8, 12, -3, 10, -5, -6, -4, 14, -7, 16, -8, -9];
const MB_YMODE_TO_BMODE: readonly number[] = [0, 2, 3, 1];

const KF_BMODE_PROBS = new Uint8Array([
  231,120,48,89,115,113,120,152,112, 152,179,64,126,170,118,46,70,95, 175,69,143,80,85,82,72,155,103, 56,58,10,171,218,189,17,13,152, 144,71,10,38,171,213,144,34,26, 114,26,17,163,44,195,21,10,173, 121,24,80,195,26,62,44,64,85, 170,46,55,19,136,160,33,206,71, 63,20,8,114,114,208,12,9,226, 81,40,11,96,182,84,29,16,36,
  134,183,89,137,98,101,106,165,148, 72,187,100,130,157,111,32,75,80, 66,102,167,99,74,62,40,234,128, 41,53,9,178,241,141,26,8,107, 104,79,12,27,217,255,87,17,7, 74,43,26,146,73,166,49,23,157, 65,38,105,160,51,52,31,115,128, 87,68,71,44,114,51,15,186,23, 47,41,14,110,182,183,21,17,194, 66,45,25,102,197,189,23,18,22,
  88,88,147,150,42,46,45,196,205, 43,97,183,117,85,38,35,179,61, 39,53,200,87,26,21,43,232,171, 56,34,51,104,114,102,29,93,77, 107,54,32,26,51,1,81,43,31, 39,28,85,171,58,165,90,98,64, 34,22,116,206,23,34,43,166,73, 68,25,106,22,64,171,36,225,114, 34,19,21,102,132,188,16,76,124, 62,18,78,95,85,57,50,48,51,
  193,101,35,159,215,111,89,46,111, 60,148,31,172,219,228,21,18,111, 112,113,77,85,179,255,38,120,114, 40,42,1,196,245,209,10,25,109, 100,80,8,43,154,1,51,26,71, 88,43,29,140,166,213,37,43,154, 61,63,30,155,67,45,68,1,209, 142,78,78,16,255,128,34,197,171, 41,40,5,102,211,183,4,1,221, 51,50,17,168,209,192,23,25,82,
  125,98,42,88,104,85,117,175,82, 95,84,53,89,128,100,113,101,45, 75,79,123,47,51,128,81,171,1, 57,17,5,71,102,57,53,41,49, 115,21,2,10,102,255,166,23,6, 38,33,13,121,57,73,26,1,85, 41,10,67,138,77,110,90,47,114, 101,29,16,10,85,128,101,196,26, 57,18,10,102,102,213,34,20,43, 117,20,15,36,163,128,68,1,26,
  138,31,36,171,27,166,38,44,229, 67,87,58,169,82,115,26,59,179, 63,59,90,180,59,166,93,73,154, 40,40,21,116,143,209,34,39,175, 57,46,22,24,128,1,54,17,37, 47,15,16,183,34,223,49,45,183, 46,17,33,183,6,98,15,32,183, 65,32,73,115,28,128,23,128,205, 40,3,9,115,51,192,18,6,223, 87,37,9,115,59,77,64,21,47,
  104,55,44,218,9,54,53,130,226, 64,90,70,205,40,41,23,26,57, 54,57,112,184,5,41,38,166,213, 30,34,26,133,152,116,10,32,134, 75,32,12,51,192,255,160,43,51, 39,19,53,221,26,114,32,73,255, 31,9,65,234,2,15,1,118,73, 88,31,35,67,102,85,55,186,85, 56,21,23,111,59,205,45,37,192, 55,38,70,124,73,102,1,34,98,
  102,61,71,37,34,53,31,243,192, 69,60,71,38,73,119,28,222,37, 68,45,128,34,1,47,11,245,171, 62,17,19,70,146,85,55,62,70, 75,15,9,9,64,255,184,119,16, 37,43,37,154,100,163,85,160,1, 63,9,92,136,28,64,32,201,85, 86,6,28,5,64,255,25,248,1, 56,8,17,132,137,255,55,116,128, 58,35,20,82,135,57,26,121,40,
  164,50,31,137,154,133,25,35,218, 51,103,44,131,131,123,31,6,158, 86,40,64,135,148,224,45,183,128, 22,26,17,131,240,154,14,1,209, 83,12,13,54,192,255,68,47,28, 45,16,21,91,64,222,7,1,197, 56,21,39,155,60,138,23,102,213, 85,26,85,85,128,128,32,146,171, 18,11,7,63,144,171,4,4,246, 35,27,10,146,174,171,12,26,128,
  190,80,35,99,180,80,126,54,45, 85,126,47,87,176,51,41,20,32, 101,75,128,139,118,146,116,128,85, 56,41,15,176,236,85,37,9,62, 146,36,19,30,171,255,97,27,20, 71,30,17,119,118,255,17,18,138, 101,38,60,138,55,70,43,26,142, 138,45,61,62,219,1,81,188,64, 32,41,20,117,151,142,20,21,163, 112,19,12,61,195,128,48,4,24,
]);

const COEFF_UPDATE_PROBS = new Uint8Array([
  255,255,255,255,255,255,255,255,255,255,255, 255,255,255,255,255,255,255,255,255,255,255, 255,255,255,255,255,255,255,255,255,255,255,
  176,246,255,255,255,255,255,255,255,255,255, 223,241,252,255,255,255,255,255,255,255,255, 249,253,253,255,255,255,255,255,255,255,255,
  255,244,252,255,255,255,255,255,255,255,255, 234,254,254,255,255,255,255,255,255,255,255, 253,255,255,255,255,255,255,255,255,255,255,
  255,246,254,255,255,255,255,255,255,255,255, 239,253,254,255,255,255,255,255,255,255,255, 254,255,254,255,255,255,255,255,255,255,255,
  255,248,254,255,255,255,255,255,255,255,255, 251,255,254,255,255,255,255,255,255,255,255, 255,255,255,255,255,255,255,255,255,255,255,
  255,253,254,255,255,255,255,255,255,255,255, 251,254,254,255,255,255,255,255,255,255,255, 254,255,254,255,255,255,255,255,255,255,255,
  255,254,253,255,254,255,255,255,255,255,255, 250,255,254,255,254,255,255,255,255,255,255, 254,255,255,255,255,255,255,255,255,255,255,
  255,255,255,255,255,255,255,255,255,255,255, 255,255,255,255,255,255,255,255,255,255,255, 255,255,255,255,255,255,255,255,255,255,255,

  217,255,255,255,255,255,255,255,255,255,255, 225,252,241,253,255,255,254,255,255,255,255, 234,250,241,250,253,255,253,254,255,255,255,
  255,254,255,255,255,255,255,255,255,255,255, 223,254,254,255,255,255,255,255,255,255,255, 238,253,254,254,255,255,255,255,255,255,255,
  255,248,254,255,255,255,255,255,255,255,255, 249,254,255,255,255,255,255,255,255,255,255, 255,255,255,255,255,255,255,255,255,255,255,
  255,253,255,255,255,255,255,255,255,255,255, 247,254,255,255,255,255,255,255,255,255,255, 255,255,255,255,255,255,255,255,255,255,255,
  255,253,254,255,255,255,255,255,255,255,255, 252,255,255,255,255,255,255,255,255,255,255, 255,255,255,255,255,255,255,255,255,255,255,
  255,254,254,255,255,255,255,255,255,255,255, 253,255,255,255,255,255,255,255,255,255,255, 255,255,255,255,255,255,255,255,255,255,255,
  255,254,253,255,255,255,255,255,255,255,255, 250,255,255,255,255,255,255,255,255,255,255, 254,255,255,255,255,255,255,255,255,255,255,
  255,255,255,255,255,255,255,255,255,255,255, 255,255,255,255,255,255,255,255,255,255,255, 255,255,255,255,255,255,255,255,255,255,255,

  186,251,250,255,255,255,255,255,255,255,255, 234,251,244,254,255,255,255,255,255,255,255, 251,251,243,253,254,255,254,255,255,255,255,
  255,253,254,255,255,255,255,255,255,255,255, 236,253,254,255,255,255,255,255,255,255,255, 251,253,253,254,254,255,255,255,255,255,255,
  255,254,254,255,255,255,255,255,255,255,255, 254,254,254,255,255,255,255,255,255,255,255, 255,255,255,255,255,255,255,255,255,255,255,
  255,254,255,255,255,255,255,255,255,255,255, 254,254,255,255,255,255,255,255,255,255,255, 254,255,255,255,255,255,255,255,255,255,255,
  255,255,255,255,255,255,255,255,255,255,255, 254,255,255,255,255,255,255,255,255,255,255, 255,255,255,255,255,255,255,255,255,255,255,
  255,255,255,255,255,255,255,255,255,255,255, 255,255,255,255,255,255,255,255,255,255,255, 255,255,255,255,255,255,255,255,255,255,255,
  255,255,255,255,255,255,255,255,255,255,255, 255,255,255,255,255,255,255,255,255,255,255, 255,255,255,255,255,255,255,255,255,255,255,
  255,255,255,255,255,255,255,255,255,255,255, 255,255,255,255,255,255,255,255,255,255,255, 255,255,255,255,255,255,255,255,255,255,255,

  248,255,255,255,255,255,255,255,255,255,255, 250,254,252,254,255,255,255,255,255,255,255, 248,254,249,253,255,255,255,255,255,255,255,
  255,253,253,255,255,255,255,255,255,255,255, 246,253,253,255,255,255,255,255,255,255,255, 252,254,251,254,254,255,255,255,255,255,255,
  255,254,252,255,255,255,255,255,255,255,255, 248,254,253,255,255,255,255,255,255,255,255, 253,255,254,254,255,255,255,255,255,255,255,
  255,251,254,255,255,255,255,255,255,255,255, 245,251,254,255,255,255,255,255,255,255,255, 253,253,254,255,255,255,255,255,255,255,255,
  255,251,253,255,255,255,255,255,255,255,255, 252,253,254,255,255,255,255,255,255,255,255, 255,254,255,255,255,255,255,255,255,255,255,
  255,252,255,255,255,255,255,255,255,255,255, 249,255,254,255,255,255,255,255,255,255,255, 255,255,254,255,255,255,255,255,255,255,255,
  255,255,253,255,255,255,255,255,255,255,255, 250,255,255,255,255,255,255,255,255,255,255, 255,255,255,255,255,255,255,255,255,255,255,
  255,255,255,255,255,255,255,255,255,255,255, 254,255,255,255,255,255,255,255,255,255,255, 255,255,255,255,255,255,255,255,255,255,255,
]);

const DEFAULT_COEFF_PROBS = new Uint8Array([
  128,128,128,128,128,128,128,128,128,128,128, 128,128,128,128,128,128,128,128,128,128,128, 128,128,128,128,128,128,128,128,128,128,128,
  253,136,254,255,228,219,128,128,128,128,128, 189,129,242,255,227,213,255,219,128,128,128, 106,126,227,252,214,209,255,255,128,128,128,
  1,98,248,255,236,226,255,255,128,128,128, 181,133,238,254,221,234,255,154,128,128,128, 78,134,202,247,198,180,255,219,128,128,128,
  1,185,249,255,243,255,128,128,128,128,128, 184,150,247,255,236,224,128,128,128,128,128, 77,110,216,255,236,230,128,128,128,128,128,
  1,101,251,255,241,255,128,128,128,128,128, 170,139,241,252,236,209,255,255,128,128,128, 37,116,196,243,228,255,255,255,128,128,128,
  1,204,254,255,245,255,128,128,128,128,128, 207,160,250,255,238,128,128,128,128,128,128, 102,103,231,255,211,171,128,128,128,128,128,
  1,152,252,255,240,255,128,128,128,128,128, 177,135,243,255,234,225,128,128,128,128,128, 80,129,211,255,194,224,128,128,128,128,128,
  1,1,255,128,128,128,128,128,128,128,128, 246,1,255,128,128,128,128,128,128,128,128, 255,128,128,128,128,128,128,128,128,128,128,

  198,35,237,223,193,187,162,160,145,155,62, 131,45,198,221,172,176,220,157,252,221,1, 68,47,146,208,149,167,221,162,255,223,128,
  1,149,241,255,221,224,255,255,128,128,128, 184,141,234,253,222,220,255,199,128,128,128, 81,99,181,242,176,190,249,202,255,255,128,
  1,129,232,253,214,197,242,196,255,255,128, 99,121,210,250,201,198,255,202,128,128,128, 23,91,163,242,170,187,247,210,255,255,128,
  1,200,246,255,234,255,128,128,128,128,128, 109,178,241,255,231,245,255,255,128,128,128, 44,130,201,253,205,192,255,255,128,128,128,
  1,132,239,251,219,209,255,165,128,128,128, 94,136,225,251,218,190,255,255,128,128,128, 22,100,174,245,186,161,255,199,128,128,128,
  1,182,249,255,232,235,128,128,128,128,128, 124,143,241,255,227,234,128,128,128,128,128, 35,77,181,251,193,211,255,205,128,128,128,
  1,157,247,255,236,231,255,255,128,128,128, 121,141,235,255,225,227,255,255,128,128,128, 45,99,188,251,195,217,255,224,128,128,128,
  1,1,251,255,213,255,128,128,128,128,128, 203,1,248,255,255,128,128,128,128,128,128, 137,1,177,255,224,255,128,128,128,128,128,

  253,9,248,251,207,208,255,192,128,128,128, 175,13,224,243,193,185,249,198,255,255,128, 73,17,171,221,161,179,236,167,255,234,128,
  1,95,247,253,212,183,255,255,128,128,128, 239,90,244,250,211,209,255,255,128,128,128, 155,77,195,248,188,195,255,255,128,128,128,
  1,24,239,251,218,219,255,205,128,128,128, 201,51,219,255,196,186,128,128,128,128,128, 69,46,190,239,201,218,255,228,128,128,128,
  1,191,251,255,255,128,128,128,128,128,128, 223,165,249,255,213,255,128,128,128,128,128, 141,124,248,255,255,128,128,128,128,128,128,
  1,16,248,255,255,128,128,128,128,128,128, 190,36,230,255,236,255,128,128,128,128,128, 149,1,255,128,128,128,128,128,128,128,128,
  1,226,255,128,128,128,128,128,128,128,128, 247,192,255,128,128,128,128,128,128,128,128, 240,128,255,128,128,128,128,128,128,128,128,
  1,134,252,255,255,128,128,128,128,128,128, 213,62,250,255,255,128,128,128,128,128,128, 55,93,255,128,128,128,128,128,128,128,128,
  128,128,128,128,128,128,128,128,128,128,128, 128,128,128,128,128,128,128,128,128,128,128, 128,128,128,128,128,128,128,128,128,128,128,

  202,24,213,235,186,191,220,160,240,175,255, 126,38,182,232,169,184,228,174,255,187,128, 61,46,138,219,151,178,240,170,255,216,128,
  1,112,230,250,199,191,247,159,255,255,128, 166,109,228,252,211,215,255,174,128,128,128, 39,77,162,232,172,180,245,178,255,255,128,
  1,52,220,246,198,199,249,220,255,255,128, 124,74,191,243,183,193,250,221,255,255,128, 24,71,130,219,154,170,243,182,255,255,128,
  1,182,225,249,219,240,255,224,128,128,128, 149,150,226,252,216,205,255,171,128,128,128, 28,108,170,242,183,194,254,223,255,255,128,
  1,81,230,252,204,203,255,192,128,128,128, 123,102,209,247,188,196,255,233,128,128,128, 20,95,153,243,164,173,255,203,128,128,128,
  1,222,248,255,216,213,128,128,128,128,128, 168,175,246,252,235,205,255,255,128,128,128, 47,116,215,255,211,212,255,255,128,128,128,
  1,121,236,253,212,214,255,255,128,128,128, 141,84,213,252,201,202,255,219,128,128,128, 42,80,160,240,162,185,255,205,128,128,128,
  1,1,255,128,128,128,128,128,128,128,128, 244,1,255,128,128,128,128,128,128,128,128, 238,1,255,128,128,128,128,128,128,128,128,
]);

class Vp8BoolDecoder {
  private pos = 0;
  private value = 0;
  private range = 255;
  private bitCount = 0;
  private eofBytes = 0;
  corrupt = false;

  constructor(private readonly data: Uint8Array) {
    const b0 = data.length > 0 ? data[0]! : 0;
    const b1 = data.length > 1 ? data[1]! : 0;
    this.value = (b0 << 8) | b1;
    this.pos = 2;
    this.eofBytes = data.length === 0 ? 2 : data.length === 1 ? 1 : 0;
  }

  readBool(prob: number): number {
    if (this.eofBytes >= 2) {
      this.corrupt = true;
      return 0;
    }
    const split = 1 + (((this.range - 1) * prob) >>> 8);
    const bigSplit = split << 8;
    let bit = 0;
    if (this.value >= bigSplit) {
      bit = 1;
      this.range -= split;
      this.value -= bigSplit;
    } else {
      this.range = split;
    }
    while (this.range < 128) {
      this.value <<= 1;
      this.range <<= 1;
      this.bitCount += 1;
      if (this.bitCount === 8) {
        this.bitCount = 0;
        if (this.pos < this.data.length) {
          this.value |= this.data[this.pos]!;
          this.pos += 1;
        } else {
          this.eofBytes += 1;
          if (this.eofBytes > 2) this.corrupt = true;
        }
      }
    }
    return bit;
  }

  readFlag(): number {
    return this.readBool(128);
  }

  readLiteral(n: number): number {
    let v = 0;
    for (let i = 0; i < n; i += 1) v = (v << 1) | this.readBool(128);
    return v;
  }

  readTree(tree: readonly number[], probs: ArrayLike<number>, probBase = 0): number {
    let i = 0;
    for (;;) {
      const next = tree[i + this.readBool(probs[probBase + (i >> 1)]!)]!;
      if (next <= 0) return -next;
      i = next;
    }
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function clamp255(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

function readDeltaQ(bd: Vp8BoolDecoder): number {
  if (bd.readFlag() === 0) return 0;
  const mag = bd.readLiteral(4);
  return bd.readFlag() === 1 ? -mag : mag;
}

function readCat(bd: Vp8BoolDecoder, probs: readonly number[]): number {
  let v = 0;
  for (let i = 0; i < probs.length; i += 1) v = (v << 1) | bd.readBool(probs[i]!);
  return v;
}

function decodeBlockCoeffs(
  bd: Vp8BoolDecoder,
  coeffProbs: Uint8Array,
  planeType: number,
  firstCoeff: number,
  initialCtx: number,
  dcQuant: number,
  acQuant: number,
  out: Int32Array,
): number {
  out.fill(0);
  let ctx = initialCtx;
  let skipEob = false;
  let hasNonZero = 0;
  for (let c = firstCoeff; c < 16; c += 1) {
    const base = ((planeType * 8 + COEFF_BANDS[c]!) * 3 + ctx) * 11;
    if (!skipEob && bd.readBool(coeffProbs[base]!) === 0) break;
    if (bd.readBool(coeffProbs[base + 1]!) === 0) {
      ctx = 0;
      skipEob = true;
      continue;
    }
    skipEob = false;
    hasNonZero = 1;
    let absVal: number;
    if (bd.readBool(coeffProbs[base + 2]!) === 0) {
      absVal = 1;
      ctx = 1;
    } else {
      ctx = 2;
      if (bd.readBool(coeffProbs[base + 3]!) === 0) {
        if (bd.readBool(coeffProbs[base + 4]!) === 0) {
          absVal = 2;
        } else {
          absVal = 3 + bd.readBool(coeffProbs[base + 5]!);
        }
      } else if (bd.readBool(coeffProbs[base + 6]!) === 0) {
        if (bd.readBool(coeffProbs[base + 7]!) === 0) {
          absVal = 5 + readCat(bd, PCAT1);
        } else {
          absVal = 7 + readCat(bd, PCAT2);
        }
      } else {
        const b8 = bd.readBool(coeffProbs[base + 8]!);
        const b9 = bd.readBool(coeffProbs[base + 9 + b8]!);
        const cat = (b8 << 1) + b9;
        if (cat === 0) absVal = 11 + readCat(bd, PCAT3);
        else if (cat === 1) absVal = 19 + readCat(bd, PCAT4);
        else if (cat === 2) absVal = 35 + readCat(bd, PCAT5);
        else absVal = 67 + readCat(bd, PCAT6);
      }
    }
    const signed = bd.readFlag() === 1 ? -absVal : absVal;
    out[ZIGZAG_4X4[c]!] = signed * (c === 0 ? dcQuant : acQuant);
  }
  return hasNonZero;
}

function iwht4x4(ip: Int32Array, out: Int32Array): void {
  for (let i = 0; i < 4; i += 1) {
    const a1 = ip[i]! + ip[12 + i]!;
    const b1 = ip[4 + i]! + ip[8 + i]!;
    const c1 = ip[4 + i]! - ip[8 + i]!;
    const d1 = ip[i]! - ip[12 + i]!;
    out[i] = a1 + b1;
    out[4 + i] = c1 + d1;
    out[8 + i] = a1 - b1;
    out[12 + i] = d1 - c1;
  }
  for (let j = 0; j < 16; j += 4) {
    const a1 = out[j]! + out[j + 3]!;
    const b1 = out[j + 1]! + out[j + 2]!;
    const c1 = out[j + 1]! - out[j + 2]!;
    const d1 = out[j]! - out[j + 3]!;
    out[j] = (a1 + b1 + 3) >> 3;
    out[j + 1] = (c1 + d1 + 3) >> 3;
    out[j + 2] = (a1 - b1 + 3) >> 3;
    out[j + 3] = (d1 - c1 + 3) >> 3;
  }
}

function idct4x4Add(ip: Int32Array, plane: Uint8Array, stride: number, baseOff: number, tmp: Int32Array): void {
  for (let i = 0; i < 4; i += 1) {
    const i0 = ip[i]!, i1 = ip[4 + i]!, i2 = ip[8 + i]!, i3 = ip[12 + i]!;
    const a1 = i0 + i2;
    const b1 = i0 - i2;
    const t1 = (i1 * 35468) >> 16;
    const t2 = i3 + ((i3 * 20091) >> 16);
    const c1 = t1 - t2;
    const d1 = i1 + ((i1 * 20091) >> 16) + ((i3 * 35468) >> 16);
    tmp[i] = a1 + d1;
    tmp[12 + i] = a1 - d1;
    tmp[4 + i] = b1 + c1;
    tmp[8 + i] = b1 - c1;
  }
  for (let r = 0; r < 4; r += 1) {
    const j = r * 4;
    const t0 = tmp[j]!, t1 = tmp[j + 1]!, t2 = tmp[j + 2]!, t3 = tmp[j + 3]!;
    const a1 = t0 + t2;
    const b1 = t0 - t2;
    const c1 = ((t1 * 35468) >> 16) - (t3 + ((t3 * 20091) >> 16));
    const d1 = t1 + ((t1 * 20091) >> 16) + ((t3 * 35468) >> 16);
    const row = baseOff + r * stride;
    plane[row] = clamp255(plane[row]! + ((a1 + d1 + 4) >> 3));
    plane[row + 1] = clamp255(plane[row + 1]! + ((b1 + c1 + 4) >> 3));
    plane[row + 2] = clamp255(plane[row + 2]! + ((b1 - c1 + 4) >> 3));
    plane[row + 3] = clamp255(plane[row + 3]! + ((a1 - d1 + 4) >> 3));
  }
}

function predictBlockMb(
  plane: Uint8Array,
  stride: number,
  baseOff: number,
  size: number,
  log2Size: number,
  mode: number,
  hasTop: boolean,
  hasLeft: boolean,
): void {
  if (mode === 0) {
    let dc = 128;
    if (hasTop && hasLeft) {
      let sum = 0;
      for (let i = 0; i < size; i += 1) {
        sum += plane[baseOff - stride + i]! + plane[baseOff + i * stride - 1]!;
      }
      dc = (sum + size) >> (log2Size + 1);
    } else if (hasTop) {
      let sum = 0;
      for (let i = 0; i < size; i += 1) sum += plane[baseOff - stride + i]!;
      dc = (sum + (size >> 1)) >> log2Size;
    } else if (hasLeft) {
      let sum = 0;
      for (let i = 0; i < size; i += 1) sum += plane[baseOff + i * stride - 1]!;
      dc = (sum + (size >> 1)) >> log2Size;
    }
    for (let r = 0; r < size; r += 1) {
      const row = baseOff + r * stride;
      plane.fill(dc, row, row + size);
    }
  } else if (mode === 1) {
    for (let r = 0; r < size; r += 1) {
      const row = baseOff + r * stride;
      for (let c = 0; c < size; c += 1) plane[row + c] = plane[baseOff - stride + c]!;
    }
  } else if (mode === 2) {
    for (let r = 0; r < size; r += 1) {
      const row = baseOff + r * stride;
      plane.fill(plane[row - 1]!, row, row + size);
    }
  } else {
    const p = plane[baseOff - stride - 1]!;
    for (let r = 0; r < size; r += 1) {
      const row = baseOff + r * stride;
      const l = plane[row - 1]!;
      for (let c = 0; c < size; c += 1) {
        plane[row + c] = clamp255(l + plane[baseOff - stride + c]! - p);
      }
    }
  }
}

function avg2(a: number, b: number): number {
  return (a + b + 1) >> 1;
}

function avg3(a: number, b: number, c: number): number {
  return (a + 2 * b + c + 2) >> 2;
}

function predict4x4(
  plane: Uint8Array,
  stride: number,
  baseOff: number,
  mbTopOff: number,
  sbCol: number,
  mode: number,
): void {
  const p = plane[baseOff - stride - 1]!;
  const a0 = plane[baseOff - stride]!;
  const a1 = plane[baseOff - stride + 1]!;
  const a2 = plane[baseOff - stride + 2]!;
  const a3 = plane[baseOff - stride + 3]!;
  const arOff = sbCol === 3 ? mbTopOff + 16 : baseOff - stride + 4;
  const a4 = plane[arOff]!;
  const a5 = plane[arOff + 1]!;
  const a6 = plane[arOff + 2]!;
  const a7 = plane[arOff + 3]!;
  const l0 = plane[baseOff - 1]!;
  const l1 = plane[baseOff + stride - 1]!;
  const l2 = plane[baseOff + 2 * stride - 1]!;
  const l3 = plane[baseOff + 3 * stride - 1]!;
  const r0 = baseOff, r1 = baseOff + stride, r2 = baseOff + 2 * stride, r3 = baseOff + 3 * stride;

  switch (mode) {
    case 0: {
      const dc = (a0 + a1 + a2 + a3 + l0 + l1 + l2 + l3 + 4) >> 3;
      plane.fill(dc, r0, r0 + 4); plane.fill(dc, r1, r1 + 4);
      plane.fill(dc, r2, r2 + 4); plane.fill(dc, r3, r3 + 4);
      break;
    }
    case 1:
      plane[r0] = clamp255(l0 + a0 - p); plane[r0 + 1] = clamp255(l0 + a1 - p); plane[r0 + 2] = clamp255(l0 + a2 - p); plane[r0 + 3] = clamp255(l0 + a3 - p);
      plane[r1] = clamp255(l1 + a0 - p); plane[r1 + 1] = clamp255(l1 + a1 - p); plane[r1 + 2] = clamp255(l1 + a2 - p); plane[r1 + 3] = clamp255(l1 + a3 - p);
      plane[r2] = clamp255(l2 + a0 - p); plane[r2 + 1] = clamp255(l2 + a1 - p); plane[r2 + 2] = clamp255(l2 + a2 - p); plane[r2 + 3] = clamp255(l2 + a3 - p);
      plane[r3] = clamp255(l3 + a0 - p); plane[r3 + 1] = clamp255(l3 + a1 - p); plane[r3 + 2] = clamp255(l3 + a2 - p); plane[r3 + 3] = clamp255(l3 + a3 - p);
      break;
    case 2: {
      const v0 = avg3(p, a0, a1), v1 = avg3(a0, a1, a2), v2 = avg3(a1, a2, a3), v3 = avg3(a2, a3, a4);
      for (const r of [r0, r1, r2, r3]) { plane[r] = v0; plane[r + 1] = v1; plane[r + 2] = v2; plane[r + 3] = v3; }
      break;
    }
    case 3:
      plane.fill(avg3(p, l0, l1), r0, r0 + 4); plane.fill(avg3(l0, l1, l2), r1, r1 + 4);
      plane.fill(avg3(l1, l2, l3), r2, r2 + 4); plane.fill(avg3(l2, l3, l3), r3, r3 + 4);
      break;
    case 4:
      plane[r0] = avg3(a0, a1, a2);
      plane[r0 + 1] = plane[r1] = avg3(a1, a2, a3);
      plane[r0 + 2] = plane[r1 + 1] = plane[r2] = avg3(a2, a3, a4);
      plane[r0 + 3] = plane[r1 + 2] = plane[r2 + 1] = plane[r3] = avg3(a3, a4, a5);
      plane[r1 + 3] = plane[r2 + 2] = plane[r3 + 1] = avg3(a4, a5, a6);
      plane[r2 + 3] = plane[r3 + 2] = avg3(a5, a6, a7);
      plane[r3 + 3] = avg3(a6, a7, a7);
      break;
    case 5:
      plane[r3] = avg3(l3, l2, l1);
      plane[r3 + 1] = plane[r2] = avg3(l2, l1, l0);
      plane[r3 + 2] = plane[r2 + 1] = plane[r1] = avg3(l1, l0, p);
      plane[r3 + 3] = plane[r2 + 2] = plane[r1 + 1] = plane[r0] = avg3(l0, p, a0);
      plane[r2 + 3] = plane[r1 + 2] = plane[r0 + 1] = avg3(p, a0, a1);
      plane[r1 + 3] = plane[r0 + 2] = avg3(a0, a1, a2);
      plane[r0 + 3] = avg3(a1, a2, a3);
      break;
    case 6:
      plane[r3] = avg3(l2, l1, l0); plane[r2] = avg3(l1, l0, p);
      plane[r3 + 1] = plane[r1] = avg3(l0, p, a0); plane[r2 + 1] = plane[r0] = avg2(p, a0);
      plane[r3 + 2] = plane[r1 + 1] = avg3(p, a0, a1); plane[r2 + 2] = plane[r0 + 1] = avg2(a0, a1);
      plane[r3 + 3] = plane[r1 + 2] = avg3(a0, a1, a2); plane[r2 + 3] = plane[r0 + 2] = avg2(a1, a2);
      plane[r1 + 3] = avg3(a1, a2, a3); plane[r0 + 3] = avg2(a2, a3);
      break;
    case 7:
      plane[r0] = avg2(a0, a1); plane[r1] = avg3(a0, a1, a2);
      plane[r2] = plane[r0 + 1] = avg2(a1, a2); plane[r1 + 1] = plane[r3] = avg3(a1, a2, a3);
      plane[r2 + 1] = plane[r0 + 2] = avg2(a2, a3); plane[r1 + 2] = plane[r3 + 1] = avg3(a2, a3, a4);
      plane[r2 + 2] = plane[r0 + 3] = avg2(a3, a4); plane[r1 + 3] = plane[r3 + 2] = avg3(a3, a4, a5);
      plane[r2 + 3] = avg3(a4, a5, a6); plane[r3 + 3] = avg3(a5, a6, a7);
      break;
    case 8:
      plane[r0] = plane[r1 + 2] = avg2(p, l0); plane[r0 + 1] = plane[r1 + 3] = avg3(l0, p, a0);
      plane[r0 + 2] = avg3(p, a0, a1); plane[r0 + 3] = avg3(a0, a1, a2);
      plane[r1] = plane[r2 + 2] = avg2(l0, l1); plane[r1 + 1] = plane[r2 + 3] = avg3(l1, l0, p);
      plane[r2] = plane[r3 + 2] = avg2(l1, l2); plane[r2 + 1] = plane[r3 + 3] = avg3(l2, l1, l0);
      plane[r3] = avg2(l2, l3); plane[r3 + 1] = avg3(l3, l2, l1);
      break;
    default:
      plane[r0] = avg2(l0, l1); plane[r0 + 1] = avg3(l0, l1, l2);
      plane[r0 + 2] = plane[r1] = avg2(l1, l2); plane[r0 + 3] = plane[r1 + 1] = avg3(l1, l2, l3);
      plane[r1 + 2] = plane[r2] = avg2(l2, l3); plane[r1 + 3] = plane[r2 + 1] = avg3(l2, l3, l3);
      plane[r2 + 2] = plane[r2 + 3] = plane[r3] = plane[r3 + 1] = plane[r3 + 2] = plane[r3 + 3] = l3;
      break;
  }
}

function sc(v: number): number {
  return v < -128 ? -128 : v > 127 ? 127 : v;
}

function s2u(v: number): number {
  return sc(v) + 128;
}

function filterEdgeNormal(
  plane: Uint8Array,
  q0Idx: number,
  step: number,
  interiorLimit: number,
  edgeLimit: number,
  hevThreshold: number,
  isMbEdge: boolean,
): void {
  const p3 = plane[q0Idx - 4 * step]!, p2 = plane[q0Idx - 3 * step]!;
  const p1 = plane[q0Idx - 2 * step]!, p0 = plane[q0Idx - step]!;
  const q0 = plane[q0Idx]!, q1 = plane[q0Idx + step]!;
  const q2 = plane[q0Idx + 2 * step]!, q3 = plane[q0Idx + 3 * step]!;
  if (
    Math.abs(p3 - p2) > interiorLimit || Math.abs(p2 - p1) > interiorLimit ||
    Math.abs(p1 - p0) > interiorLimit || Math.abs(q3 - q2) > interiorLimit ||
    Math.abs(q2 - q1) > interiorLimit || Math.abs(q1 - q0) > interiorLimit ||
    Math.abs(p0 - q0) * 2 + (Math.abs(p1 - q1) >> 1) > edgeLimit
  ) {
    return;
  }
  const hev = Math.abs(p1 - p0) > hevThreshold || Math.abs(q1 - q0) > hevThreshold;
  const ps1 = p1 - 128, ps0 = p0 - 128, qs0 = q0 - 128, qs1 = q1 - 128;
  if (isMbEdge && !hev) {
    const ps2 = p2 - 128, qs2 = q2 - 128;
    const w = sc(sc(ps1 - qs1) + 3 * (qs0 - ps0));
    const a0 = (27 * w + 63) >> 7, a1 = (18 * w + 63) >> 7, a2 = (9 * w + 63) >> 7;
    plane[q0Idx] = s2u(qs0 - a0); plane[q0Idx - step] = s2u(ps0 + a0);
    plane[q0Idx + step] = s2u(qs1 - a1); plane[q0Idx - 2 * step] = s2u(ps1 + a1);
    plane[q0Idx + 2 * step] = s2u(qs2 - a2); plane[q0Idx - 3 * step] = s2u(ps2 + a2);
  } else {
    const a = sc((hev ? sc(ps1 - qs1) : 0) + 3 * (qs0 - ps0));
    const f1 = sc(a + 3) >> 3;
    const f2 = sc(a + 4) >> 3;
    plane[q0Idx] = s2u(qs0 - f2);
    plane[q0Idx - step] = s2u(ps0 + f1);
    if (!hev) {
      const fOuter = (f2 + 1) >> 1;
      plane[q0Idx + step] = s2u(qs1 - fOuter);
      plane[q0Idx - 2 * step] = s2u(ps1 + fOuter);
    }
  }
}

function filterEdgeSimple(plane: Uint8Array, q0Idx: number, step: number, edgeLimit: number): void {
  const p1 = plane[q0Idx - 2 * step]!, p0 = plane[q0Idx - step]!;
  const q0 = plane[q0Idx]!, q1 = plane[q0Idx + step]!;
  if (Math.abs(p0 - q0) * 2 + (Math.abs(p1 - q1) >> 1) > edgeLimit) return;
  const ps1 = p1 - 128, ps0 = p0 - 128, qs0 = q0 - 128, qs1 = q1 - 128;
  const a = sc(sc(ps1 - qs1) + 3 * (qs0 - ps0));
  plane[q0Idx] = s2u(qs0 - (sc(a + 4) >> 3));
  plane[q0Idx - step] = s2u(ps0 + (sc(a + 3) >> 3));
}

export function decodeVp8Chunk(
  chunk: Uint8Array,
  budget: DecodeBudget,
): { width: number; height: number; rgba: Uint8Array } | null {
  if (chunk.length < 10) return null;
  const tag = chunk[0]! | (chunk[1]! << 8) | (chunk[2]! << 16);
  if ((tag & 1) !== 0) return null;
  const version = (tag >>> 1) & 7;
  const showFrame = (tag >>> 4) & 1;
  const firstPartSize = tag >>> 5;
  if (version > 3 || showFrame === 0) return null;
  if (chunk[3] !== 0x9d || chunk[4] !== 0x01 || chunk[5] !== 0x2a) return null;

  const width = (chunk[6]! | (chunk[7]! << 8)) & 0x3fff;
  const height = (chunk[8]! | (chunk[9]! << 8)) & 0x3fff;
  if (width <= 0 || height <= 0 || 10 + firstPartSize > chunk.length) return null;
  const totalPixels = width * height;
  if (!Number.isSafeInteger(totalPixels) || !Number.isSafeInteger(totalPixels * 4)) return null;

  const bd = new Vp8BoolDecoder(chunk.subarray(10, 10 + firstPartSize));
  const colorSpace = bd.readLiteral(1);
  bd.readLiteral(1); // clamping_type
  if (colorSpace !== 0 || bd.corrupt) return null;

  const segEnabled = bd.readFlag() === 1;
  let updateSegMap = false;
  let segAbsMode = false;
  const segQuant = [0, 0, 0, 0];
  const segLf = [0, 0, 0, 0];
  const segProb = [255, 255, 255];
  if (segEnabled) {
    updateSegMap = bd.readFlag() === 1;
    if (bd.readFlag() === 1) {
      segAbsMode = bd.readFlag() === 1;
      for (let i = 0; i < 4; i += 1) {
        if (bd.readFlag() === 1) {
          const m = bd.readLiteral(7);
          segQuant[i] = bd.readFlag() === 1 ? -m : m;
        }
      }
      for (let i = 0; i < 4; i += 1) {
        if (bd.readFlag() === 1) {
          const m = bd.readLiteral(6);
          segLf[i] = bd.readFlag() === 1 ? -m : m;
        }
      }
    }
    if (updateSegMap) {
      for (let i = 0; i < 3; i += 1) segProb[i] = bd.readFlag() === 1 ? bd.readLiteral(8) : 255;
    }
  }

  const filterSimple = bd.readFlag() === 1;
  const loopFilterLevel = bd.readLiteral(6);
  const sharpnessLevel = bd.readLiteral(3);
  const lfAdjEnable = bd.readFlag() === 1;
  const refLfDelta = [0, 0, 0, 0];
  const modeLfDelta = [0, 0, 0, 0];
  if (lfAdjEnable && bd.readFlag() === 1) {
    for (let i = 0; i < 4; i += 1) {
      if (bd.readFlag() === 1) {
        const m = bd.readLiteral(6);
        refLfDelta[i] = bd.readFlag() === 1 ? -m : m;
      }
    }
    for (let i = 0; i < 4; i += 1) {
      if (bd.readFlag() === 1) {
        const m = bd.readLiteral(6);
        modeLfDelta[i] = bd.readFlag() === 1 ? -m : m;
      }
    }
  }

  const numPartitions = 1 << bd.readLiteral(2);
  const rest = chunk.subarray(10 + firstPartSize);
  const sizeTableBytes = (numPartitions - 1) * 3;
  if (rest.length < sizeTableBytes) return null;
  const dctDecoders: Vp8BoolDecoder[] = [];
  let partOff = sizeTableBytes;
  for (let p = 0; p < numPartitions - 1; p += 1) {
    const sz = rest[p * 3]! | (rest[p * 3 + 1]! << 8) | (rest[p * 3 + 2]! << 16);
    if (partOff + sz > rest.length) return null;
    dctDecoders.push(new Vp8BoolDecoder(rest.subarray(partOff, partOff + sz)));
    partOff += sz;
  }
  dctDecoders.push(new Vp8BoolDecoder(rest.subarray(partOff)));

  const yAcQi = bd.readLiteral(7);
  const yDcDelta = readDeltaQ(bd);
  const y2DcDelta = readDeltaQ(bd);
  const y2AcDelta = readDeltaQ(bd);
  const uvDcDelta = readDeltaQ(bd);
  const uvAcDelta = readDeltaQ(bd);
  bd.readFlag(); // refresh_entropy_probs

  const quantFactors = new Int32Array(24);
  for (let s = 0; s < 4; s += 1) {
    const q = segEnabled ? (segAbsMode ? segQuant[s]! : yAcQi + segQuant[s]!) : yAcQi;
    const base = s * 6;
    quantFactors[base] = DC_QLOOKUP[clamp(q + yDcDelta, 0, 127)]!;
    quantFactors[base + 1] = AC_QLOOKUP[clamp(q, 0, 127)]!;
    quantFactors[base + 2] = DC_QLOOKUP[clamp(q + y2DcDelta, 0, 127)]! * 2;
    quantFactors[base + 3] = Math.max(8, ((AC_QLOOKUP[clamp(q + y2AcDelta, 0, 127)]! * 155) / 100) | 0);
    quantFactors[base + 4] = Math.min(132, DC_QLOOKUP[clamp(q + uvDcDelta, 0, 127)]!);
    quantFactors[base + 5] = AC_QLOOKUP[clamp(q + uvAcDelta, 0, 127)]!;
  }

  const coeffProbs = new Uint8Array(DEFAULT_COEFF_PROBS);
  for (let i = 0; i < 1056; i += 1) {
    if (bd.readBool(COEFF_UPDATE_PROBS[i]!) === 1) coeffProbs[i] = bd.readLiteral(8);
  }
  const mbNoSkipCoeff = bd.readFlag() === 1;
  const probSkipFalse = mbNoSkipCoeff ? bd.readLiteral(8) : 0;
  if (bd.corrupt) return null;

  const mbWidth = (width + 15) >> 4;
  const mbHeight = (height + 15) >> 4;
  const yStride = mbWidth * 16 + 8;
  const uvStride = mbWidth * 8 + 8;
  const yPlane = budget.allocU8((mbHeight * 16 + 1) * yStride);
  const uPlane = budget.allocU8((mbHeight * 8 + 1) * uvStride);
  const vPlane = budget.allocU8((mbHeight * 8 + 1) * uvStride);
  const mbMeta = budget.allocU8(mbWidth * mbHeight * 2);
  const aboveBModes = budget.allocU8(mbWidth * 4);
  const aboveNz = budget.allocU8(mbWidth * 9);
  if (!yPlane || !uPlane || !vPlane || !mbMeta || !aboveBModes || !aboveNz) return null;

  yPlane.fill(127, 0, yStride);
  uPlane.fill(127, 0, uvStride);
  vPlane.fill(127, 0, uvStride);
  for (let y = 1; y <= mbHeight * 16; y += 1) yPlane[y * yStride] = 129;
  for (let y = 1; y <= mbHeight * 8; y += 1) {
    uPlane[y * uvStride] = 129;
    vPlane[y * uvStride] = 129;
  }

  const coeffs = new Int32Array(16 * 25);
  const whtOut = new Int32Array(16);
  const idctTmp = new Int32Array(16);
  const leftBModes = new Uint8Array(4);
  const leftNz = new Uint8Array(9);

  for (let mbRow = 0; mbRow < mbHeight; mbRow += 1) {
    leftBModes.fill(0);
    leftNz.fill(0);
    const dctBd = dctDecoders[mbRow & (numPartitions - 1)]!;
    for (let mbCol = 0; mbCol < mbWidth; mbCol += 1) {
      if (!budget.step(32)) return null;
      const segId = segEnabled && updateSegMap
        ? (bd.readBool(segProb[0]!) === 0 ? bd.readBool(segProb[1]!) : 2 + bd.readBool(segProb[2]!))
        : 0;
      const skip = mbNoSkipCoeff ? bd.readBool(probSkipFalse) === 1 : false;
      const yMode = bd.readTree(KF_YMODE_TREE, KF_YMODE_PROBS);
      const bModes = new Uint8Array(16);
      if (yMode === 4) {
        for (let sr = 0; sr < 4; sr += 1) {
          for (let scCol = 0; scCol < 4; scCol += 1) {
            const topMode = aboveBModes[mbCol * 4 + scCol]!;
            const leftMode = leftBModes[sr]!;
            const bm = bd.readTree(BMODE_TREE, KF_BMODE_PROBS, (topMode * 10 + leftMode) * 9);
            bModes[sr * 4 + scCol] = bm;
            aboveBModes[mbCol * 4 + scCol] = bm;
            leftBModes[sr] = bm;
          }
        }
      } else {
        const mapped = MB_YMODE_TO_BMODE[yMode]!;
        bModes.fill(mapped);
        aboveBModes.fill(mapped, mbCol * 4, mbCol * 4 + 4);
        leftBModes.fill(mapped);
      }
      const uvMode = bd.readTree(UV_MODE_TREE, KF_UV_MODE_PROBS);
      if (bd.corrupt) return null;

      coeffs.fill(0);
      let hasAnyCoeff = 0;
      const qBase = segId * 6;
      const aBase = mbCol * 9;

      if (skip) {
        if (yMode !== 4) {
          aboveNz[aBase + 8] = 0;
          leftNz[8] = 0;
        }
        aboveNz.fill(0, aBase, aBase + 8);
        leftNz.fill(0, 0, 8);
      } else {
        if (yMode !== 4) {
          const ctx = aboveNz[aBase + 8]! + leftNz[8]!;
          const nz = decodeBlockCoeffs(dctBd, coeffProbs, 1, 0, ctx, quantFactors[qBase + 2]!, quantFactors[qBase + 3]!, coeffs.subarray(24 * 16, 25 * 16));
          aboveNz[aBase + 8] = nz;
          leftNz[8] = nz;
          hasAnyCoeff |= nz;
          iwht4x4(coeffs.subarray(24 * 16, 25 * 16), whtOut);
        }
        const yPlaneType = yMode === 4 ? 3 : 0;
        const firstCoeff = yMode === 4 ? 0 : 1;
        for (let sr = 0; sr < 4; sr += 1) {
          for (let scCol = 0; scCol < 4; scCol += 1) {
            const blk = sr * 4 + scCol;
            const sub = coeffs.subarray(blk * 16, (blk + 1) * 16);
            const ctx = aboveNz[aBase + scCol]! + leftNz[sr]!;
            const nz = decodeBlockCoeffs(dctBd, coeffProbs, yPlaneType, firstCoeff, ctx, quantFactors[qBase]!, quantFactors[qBase + 1]!, sub);
            if (yMode !== 4) sub[0] = whtOut[blk]!;
            aboveNz[aBase + scCol] = nz;
            leftNz[sr] = nz;
            hasAnyCoeff |= nz;
          }
        }
        for (let ch = 0; ch < 2; ch += 1) {
          for (let sr = 0; sr < 2; sr += 1) {
            for (let scCol = 0; scCol < 2; scCol += 1) {
              const blk = 16 + ch * 4 + sr * 2 + scCol;
              const aIdx = 4 + ch * 2 + scCol;
              const lIdx = 4 + ch * 2 + sr;
              const ctx = aboveNz[aBase + aIdx]! + leftNz[lIdx]!;
              const nz = decodeBlockCoeffs(dctBd, coeffProbs, 2, 0, ctx, quantFactors[qBase + 4]!, quantFactors[qBase + 5]!, coeffs.subarray(blk * 16, (blk + 1) * 16));
              aboveNz[aBase + aIdx] = nz;
              leftNz[lIdx] = nz;
              hasAnyCoeff |= nz;
            }
          }
        }
        if (dctBd.corrupt) return null;
      }

      const mbIdx = (mbRow * mbWidth + mbCol) * 2;
      mbMeta[mbIdx] = segId;
      mbMeta[mbIdx + 1] = (yMode === 4 ? 1 : 0) | (hasAnyCoeff ? 2 : 0);

      const yMbOff = (mbRow * 16 + 1) * yStride + mbCol * 16 + 1;
      const mbTopOff = yMbOff - yStride;
      if (yMode !== 4) {
        predictBlockMb(yPlane, yStride, yMbOff, 16, 4, yMode, mbRow > 0, mbCol > 0);
        for (let sr = 0; sr < 4; sr += 1) {
          for (let scCol = 0; scCol < 4; scCol += 1) {
            const blk = sr * 4 + scCol;
            idct4x4Add(coeffs.subarray(blk * 16, (blk + 1) * 16), yPlane, yStride, yMbOff + sr * 4 * yStride + scCol * 4, idctTmp);
          }
        }
      } else {
        for (let sr = 0; sr < 4; sr += 1) {
          for (let scCol = 0; scCol < 4; scCol += 1) {
            const blk = sr * 4 + scCol;
            const subOff = yMbOff + sr * 4 * yStride + scCol * 4;
            predict4x4(yPlane, yStride, subOff, mbTopOff, scCol, bModes[blk]!);
            idct4x4Add(coeffs.subarray(blk * 16, (blk + 1) * 16), yPlane, yStride, subOff, idctTmp);
          }
        }
      }
      if (mbCol === mbWidth - 1) {
        for (let r = 0; r < 16; r += 1) {
          const edgeRow = yMbOff + r * yStride + 15;
          yPlane.fill(yPlane[edgeRow]!, edgeRow + 1, edgeRow + 5);
        }
      }

      const uvMbOff = (mbRow * 8 + 1) * uvStride + mbCol * 8 + 1;
      predictBlockMb(uPlane, uvStride, uvMbOff, 8, 3, uvMode, mbRow > 0, mbCol > 0);
      predictBlockMb(vPlane, uvStride, uvMbOff, 8, 3, uvMode, mbRow > 0, mbCol > 0);
      if (!skip) {
        for (let sr = 0; sr < 2; sr += 1) {
          for (let scCol = 0; scCol < 2; scCol += 1) {
            const uBlk = 16 + sr * 2 + scCol;
            const vBlk = 20 + sr * 2 + scCol;
            const off = uvMbOff + sr * 4 * uvStride + scCol * 4;
            idct4x4Add(coeffs.subarray(uBlk * 16, (uBlk + 1) * 16), uPlane, uvStride, off, idctTmp);
            idct4x4Add(coeffs.subarray(vBlk * 16, (vBlk + 1) * 16), vPlane, uvStride, off, idctTmp);
          }
        }
      }
    }
  }

  if (bd.corrupt || dctDecoders.some((d) => d.corrupt)) return null;

  // Per RFC 6386 Section 9.4 (and libwebp VP8InitFilter), frame-level
  // filter_level === 0 disables loop filtering regardless of segment/lf deltas.
  if (loopFilterLevel > 0) {
    for (let mbRow = 0; mbRow < mbHeight; mbRow += 1) {
      for (let mbCol = 0; mbCol < mbWidth; mbCol += 1) {
        if (!budget.step(16)) return null;
        const metaIdx = (mbRow * mbWidth + mbCol) * 2;
        const segId = mbMeta[metaIdx]!;
        const flags = mbMeta[metaIdx + 1]!;
        const isBPred = (flags & 1) !== 0;
        const filterInner = flags !== 0;
        let lvl = segEnabled ? (segAbsMode ? segLf[segId]! : loopFilterLevel + segLf[segId]!) : loopFilterLevel;
        if (lfAdjEnable) {
          lvl += refLfDelta[0]!;
          if (isBPred) lvl += modeLfDelta[0]!;
        }
        lvl = clamp(lvl, 0, 63);
        if (lvl === 0) continue;

        let interior = lvl;
        if (sharpnessLevel > 0) {
          interior >>= sharpnessLevel > 4 ? 2 : 1;
          if (interior > 9 - sharpnessLevel) interior = 9 - sharpnessLevel;
        }
        if (interior < 1) interior = 1;
        const hevThresh = lvl >= 40 ? 2 : lvl >= 15 ? 1 : 0;
        const mbEdgeLimit = (lvl + 2) * 2 + interior;
        const subEdgeLimit = lvl * 2 + interior;

        const yBase = (mbRow * 16 + 1) * yStride + mbCol * 16 + 1;
        const uvBase = (mbRow * 8 + 1) * uvStride + mbCol * 8 + 1;

        if (filterSimple) {
          if (mbCol > 0) for (let r = 0; r < 16; r += 1) filterEdgeSimple(yPlane, yBase + r * yStride, 1, mbEdgeLimit);
          if (filterInner) {
            for (const c of [4, 8, 12]) for (let r = 0; r < 16; r += 1) filterEdgeSimple(yPlane, yBase + r * yStride + c, 1, subEdgeLimit);
          }
          if (mbRow > 0) for (let c = 0; c < 16; c += 1) filterEdgeSimple(yPlane, yBase + c, yStride, mbEdgeLimit);
          if (filterInner) {
            for (const r of [4, 8, 12]) for (let c = 0; c < 16; c += 1) filterEdgeSimple(yPlane, yBase + r * yStride + c, yStride, subEdgeLimit);
          }
        } else {
          if (mbCol > 0) {
            for (let r = 0; r < 16; r += 1) filterEdgeNormal(yPlane, yBase + r * yStride, 1, interior, mbEdgeLimit, hevThresh, true);
            for (let r = 0; r < 8; r += 1) {
              filterEdgeNormal(uPlane, uvBase + r * uvStride, 1, interior, mbEdgeLimit, hevThresh, true);
              filterEdgeNormal(vPlane, uvBase + r * uvStride, 1, interior, mbEdgeLimit, hevThresh, true);
            }
          }
          if (filterInner) {
            for (const c of [4, 8, 12]) for (let r = 0; r < 16; r += 1) filterEdgeNormal(yPlane, yBase + r * yStride + c, 1, interior, subEdgeLimit, hevThresh, false);
            for (let r = 0; r < 8; r += 1) {
              filterEdgeNormal(uPlane, uvBase + r * uvStride + 4, 1, interior, subEdgeLimit, hevThresh, false);
              filterEdgeNormal(vPlane, uvBase + r * uvStride + 4, 1, interior, subEdgeLimit, hevThresh, false);
            }
          }
          if (mbRow > 0) {
            for (let c = 0; c < 16; c += 1) filterEdgeNormal(yPlane, yBase + c, yStride, interior, mbEdgeLimit, hevThresh, true);
            for (let c = 0; c < 8; c += 1) {
              filterEdgeNormal(uPlane, uvBase + c, uvStride, interior, mbEdgeLimit, hevThresh, true);
              filterEdgeNormal(vPlane, uvBase + c, uvStride, interior, mbEdgeLimit, hevThresh, true);
            }
          }
          if (filterInner) {
            for (const r of [4, 8, 12]) for (let c = 0; c < 16; c += 1) filterEdgeNormal(yPlane, yBase + r * yStride + c, yStride, interior, subEdgeLimit, hevThresh, false);
            for (let c = 0; c < 8; c += 1) {
              filterEdgeNormal(uPlane, uvBase + 4 * uvStride + c, uvStride, interior, subEdgeLimit, hevThresh, false);
              filterEdgeNormal(vPlane, uvBase + 4 * uvStride + c, uvStride, interior, subEdgeLimit, hevThresh, false);
            }
          }
        }
      }
    }
  }

  const rgba = budget.allocU8(totalPixels * 4);
  if (!rgba || !budget.step(totalPixels)) return null;
  const maxUvX = ((width + 1) >> 1) - 1;
  const maxUvY = ((height + 1) >> 1) - 1;
  for (let y = 0; y < height; y += 1) {
    const cy0 = clamp(y >> 1, 0, maxUvY);
    const cy1 = clamp((y & 1) === 1 ? (y >> 1) + 1 : (y >> 1) - 1, 0, maxUvY);
    const yRowOff = (y + 1) * yStride + 1;
    const uvRow0 = (cy0 + 1) * uvStride + 1;
    const uvRow1 = (cy1 + 1) * uvStride + 1;
    for (let x = 0; x < width; x += 1) {
      const cx0 = clamp(x >> 1, 0, maxUvX);
      const cx1 = clamp((x & 1) === 1 ? (x >> 1) + 1 : (x >> 1) - 1, 0, maxUvX);
      const uVal = (9 * uPlane[uvRow0 + cx0]! + 3 * uPlane[uvRow0 + cx1]! + 3 * uPlane[uvRow1 + cx0]! + uPlane[uvRow1 + cx1]! + 8) >> 4;
      const vVal = (9 * vPlane[uvRow0 + cx0]! + 3 * vPlane[uvRow0 + cx1]! + 3 * vPlane[uvRow1 + cx0]! + vPlane[uvRow1 + cx1]! + 8) >> 4;
      const yMul = (yPlane[yRowOff + x]! * 19077) >> 8;
      const dst = (y * width + x) * 4;
      rgba[dst] = clamp255((yMul + ((vVal * 26149) >> 8) - 14234) >> 6);
      rgba[dst + 1] = clamp255((yMul - ((uVal * 6419) >> 8) - ((vVal * 13320) >> 8) + 8708) >> 6);
      rgba[dst + 2] = clamp255((yMul + ((uVal * 33050) >> 8) - 17685) >> 6);
      rgba[dst + 3] = 255;
    }
  }
  return { width, height, rgba };
}
