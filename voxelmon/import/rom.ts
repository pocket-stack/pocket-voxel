// ROM byte access, text decode, BCD, and the Gen-1 pic decompressor.
// Port of gen1recomp src/import/Rom.lua (the executable spec); every
// non-obvious rule cites its source line.

import { check, hex2, hex4 } from "./ctx.ts";

const BANK_SIZE = 0x4000;

export class Rom {
  constructor(readonly data: Uint8Array) {}

  /**
   * gen1recomp Rom.lua:11 — bank 0 addresses live below $4000; every other
   * bank is addressed through the $4000-$7FFF window, file offset =
   * bank*0x4000 + addr - 0x4000.
   */
  static offset(bank: number, address: number): number {
    if (bank === 0) {
      check(
        address >= 0 && address < BANK_SIZE,
        `ROM0 address out of range: $${hex4(address)}`,
      );
      return address;
    }
    check(
      address >= BANK_SIZE && address < BANK_SIZE * 2,
      `bank ${hex2(bank)} address out of range: $${hex4(address)}`,
    );
    return bank * BANK_SIZE + address - BANK_SIZE;
  }

  byte(bank: number, address: number): number {
    const offset = Rom.offset(bank, address);
    check(offset < this.data.length, `ROM read past end at ${hex2(bank)}:${hex4(address)}`);
    return this.data[offset];
  }

  word(bank: number, address: number): number {
    return this.byte(bank, address) + this.byte(bank, address + 1) * 0x100;
  }

  /**
   * gen1recomp Rom.lua:32 — bytes() bounds-checks against the FILE, not the
   * bank: over-reads past a bank boundary are legal (compressed pics read
   * 0x8000-addr bytes and let the decompressor stop early).
   */
  bytes(bank: number, address: number, length: number): number[] {
    const first = Rom.offset(bank, address);
    check(
      first + length <= this.data.length,
      `ROM read past end at ${hex2(bank)}:${hex4(address)} + ${length}`,
    );
    const out: number[] = new Array(length);
    for (let index = 0; index < length; index++) out[index] = this.data[first + index];
    return out;
  }

  /** gen1recomp Rom.lua:44 — decode raw bytes through the charmap until stop. */
  decodeText(raw: number[], charmap: Record<string, string>, stop = 0x50): string {
    const out: string[] = [];
    for (const value of raw) {
      if (value === stop) break;
      out.push(charmap[String(value)] ?? `{BYTE:${hex2(value)}}`);
    }
    return out.join("");
  }

  /** gen1recomp Rom.lua:55 — returns [decoded, bytesConsumedIncludingStop]. */
  readString(
    bank: number,
    address: number,
    charmap: Record<string, string>,
    stop = 0x50,
    maxLength = 4096,
  ): [string, number] {
    const out: string[] = [];
    for (let offset = 0; offset < maxLength; offset++) {
      const value = this.byte(bank, address + offset);
      if (value === stop) return [out.join(""), offset + 1];
      out.push(charmap[String(value)] ?? `{BYTE:${hex2(value)}}`);
    }
    throw new Error(`unterminated string at ${hex2(bank)}:${hex4(address)}`);
  }

  /** gen1recomp Rom.lua:68 — packed BCD, most significant byte first. */
  static bcd(raw: number[]): number {
    let value = 0;
    for (const byte of raw) value = value * 100 + (byte >> 4) * 10 + (byte & 0x0f);
    return value;
  }

  static decompressPic = decompressPic;
}

/** gen1recomp Rom.lua:79 — MSB-first bit reader over the compressed bytes. */
class BitReader {
  private byte = 0;
  private bit = 7;
  constructor(readonly data: number[]) {}

  read(count = 1): number {
    let value = 0;
    for (let i = 0; i < count; i++) {
      const byte = this.data[this.byte];
      check(byte !== undefined, "compressed picture ended unexpectedly");
      value = value * 2 + ((byte >> this.bit) & 1);
      this.bit -= 1;
      if (this.bit < 0) {
        this.byte += 1;
        this.bit = 7;
      }
    }
    return value;
  }
}

/**
 * gen1recomp Rom.lua:98 — one bit plane of a compressed pic: RLE alternating
 * zero-packets and 2-bit data-packets, then column-interleaved group order
 * rewritten to rows, then packed 4 groups/byte.
 */
function fillPicPlane(reader: BitReader, width: number): number[] {
  // Rom.lua:99 — the FIRST packet kind is itself one bit of the stream.
  let mode = reader.read();
  const groupCount = width * width * 0x20;
  const groups: number[] = [];
  while (groups.length < groupCount) {
    if (mode !== 0) {
      // data packet: 2-bit groups; a 0 pair terminates and is NOT stored
      while (groups.length < groupCount) {
        const group = reader.read(2);
        if (group === 0) break;
        groups.push(group);
      }
    } else {
      // zero packet: prefix of consecutive 1-bits (Rom.lua:111 errors at 16),
      // count = 2^(p+1)-1 + read(p+1)
      let prefix = 0;
      while (reader.read() !== 0) {
        prefix += 1;
        check(prefix < 16, "invalid compressed picture zero run");
      }
      const zeroCount = 2 ** (prefix + 1) - 1 + reader.read(prefix + 1);
      const take = Math.min(zeroCount, groupCount - groups.length);
      for (let i = 0; i < take; i++) groups.push(0);
    }
    mode = 1 - mode;
  }

  // Rom.lua:123 — groups arrive column-interleaved (4 group-rows per tile
  // row); reorder to row-major before packing.
  const reordered: number[] = [];
  for (let y = 0; y < width; y++) {
    for (let x = 0; x < width * 8; x++) {
      for (let group = 0; group < 4; group++) {
        const source = (y * 4 + group) * width * 8 + x;
        reordered.push(groups[source]);
      }
    }
  }
  const packed: number[] = new Array(width * width * 8);
  for (let index = 0; index < width * width * 8; index++) {
    const start = index * 4;
    packed[index] =
      reordered[start] * 0x40 + reordered[start + 1] * 0x10 + reordered[start + 2] * 4 + reordered[start + 3];
  }
  return packed;
}

// gen1recomp Rom.lua:143 — the two 16-nibble delta-code tables; which table
// decodes a nibble depends on the carry bit left by the previous nibble.
const PIC_CODES = [
  [0x0, 0x1, 0x3, 0x2, 0x7, 0x6, 0x4, 0x5, 0xf, 0xe, 0xc, 0xd, 0x8, 0x9, 0xb, 0xa],
  [0xf, 0xe, 0xc, 0xd, 0x8, 0x9, 0xb, 0xa, 0x0, 0x1, 0x3, 0x2, 0x7, 0x6, 0x4, 0x5],
];

/**
 * gen1recomp Rom.lua:150 — per-column delta unfilter; the carry resets at the
 * top of every byte-column (bit = 0 per x), and within a byte the high nibble
 * decodes before the low one.
 */
function unfilterPicPlane(plane: number[], width: number): void {
  for (let x = 0; x < width * 8; x++) {
    let bit = 0;
    for (let y = 0; y < width; y++) {
      const index = y * width * 8 + x;
      const high = PIC_CODES[bit][plane[index] >> 4];
      bit = high % 2;
      const low = PIC_CODES[bit][plane[index] & 0x0f];
      bit = low % 2;
      plane[index] = high * 16 + low;
    }
  }
}

/**
 * gen1recomp Rom.lua:164 — 16-byte tile transpose (column-major storage to
 * row-major); the `index < other` guard swaps each pair exactly once.
 */
function transposePicTiles(data: number[], width: number): void {
  const tileCount = width * width;
  for (let index = 0; index < tileCount; index++) {
    const other = (index * width + Math.floor(index / width)) % tileCount;
    if (index < other) {
      for (let offset = 0; offset < 16; offset++) {
        const left = index * 16 + offset;
        const right = other * 16 + offset;
        const tmp = data[left];
        data[left] = data[right];
        data[right] = tmp;
      }
    }
  }
}

/**
 * gen1recomp Rom.lua:178 — the Gen-1 compressed pic decoder. Returns the
 * 2bpp bytes (low-plane-first interleave, row-major tiles) and the width in
 * tiles (pics are square, width == height, nonzero).
 */
export function decompressPic(data: number[]): [number[], number] {
  const reader = new BitReader(data);
  const width = reader.read(4);
  const height = reader.read(4);
  check(
    width !== 0 && width === height,
    `compressed picture is not a non-empty square (${width}x${height})`,
  );

  // Rom.lua:187 — the order bit picks which plane is STORED first.
  const order = reader.read();
  const planes: number[][] = [[], []];
  planes[order] = fillPicPlane(reader, width);
  // Rom.lua:189 — mode is a 1-or-2-bit prefix: "0"->0, "10"->1, "11"->2.
  let mode = reader.read();
  if (mode !== 0) mode = mode + reader.read();
  planes[1 - order] = fillPicPlane(reader, width);

  unfilterPicPlane(planes[order], width);
  // Rom.lua:194 — the second plane is NOT unfiltered when mode == 1.
  if (mode !== 1) unfilterPicPlane(planes[1 - order], width);
  // Rom.lua:195 — XOR the second-stored plane with the first when mode != 0.
  if (mode !== 0) {
    for (let index = 0; index < width * width * 8; index++) {
      planes[1 - order][index] ^= planes[order][index];
    }
  }

  // Rom.lua:202 — interleave low-plane-first into 2bpp tile bytes.
  const output: number[] = [];
  for (let index = 0; index < width * width * 8; index++) {
    output.push(planes[0][index]);
    output.push(planes[1][index]);
  }
  transposePicTiles(output, width);
  return [output, width];
}
