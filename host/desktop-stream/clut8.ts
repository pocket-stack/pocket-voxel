/**
 * A fixed RGB332 palette is a better fit for a desktop than a fresh median-cut
 * palette every frame: static UI pixels keep the same index, text stays crisp,
 * and conversion is one small integer expression per pixel.
 */

export const RGB332_PALETTE = (() => {
  const bytes = new Uint8Array(256 * 4);
  const dv = new DataView(bytes.buffer);
  for (let i = 0; i < 256; i++) {
    const r = Math.round(((i >>> 5) & 0x07) * (255 / 7));
    const g = Math.round(((i >>> 2) & 0x07) * (255 / 7));
    const b = Math.round((i & 0x03) * (255 / 3));
    const abgr = ((0xff << 24) | (b << 16) | (g << 8) | r) >>> 0;
    dv.setUint32(i * 4, abgr, true);
  }
  return bytes;
})();

/** Convert one tightly packed RGB24 frame to indices in RGB332_PALETTE. */
export function rgb24ToClut8(rgb: Uint8Array, width: number, height: number): Uint8Array {
  const pixels = width * height;
  if (rgb.length !== pixels * 3) {
    throw new Error(`desktop stream: RGB24 frame is ${rgb.length} bytes, expected ${pixels * 3}`);
  }
  const out = new Uint8Array(pixels);
  for (let i = 0; i < pixels; i++) {
    const at = i * 3;
    out[i] = (rgb[at] & 0xe0) | ((rgb[at + 1] >>> 3) & 0x1c) | (rgb[at + 2] >>> 6);
  }
  return out;
}
