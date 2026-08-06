//! Minimal PNG writer: RGBA8, one IDAT of stored (uncompressed) deflate
//! blocks. ~100 lines, zero dependencies, byte-deterministic — shots are
//! local debugging artifacts (goldens are frame hashes, never images;
//! docs/VOXEL.md §1), so compression buys nothing.

fn crc32(bytes: &[u8]) -> u32 {
    let mut table = [0u32; 256];
    for (i, entry) in table.iter_mut().enumerate() {
        let mut c = i as u32;
        for _ in 0..8 {
            c = if c & 1 != 0 {
                0xedb8_8320 ^ (c >> 1)
            } else {
                c >> 1
            };
        }
        *entry = c;
    }
    let mut c = 0xffff_ffffu32;
    for &b in bytes {
        c = table[((c ^ b as u32) & 0xff) as usize] ^ (c >> 8);
    }
    c ^ 0xffff_ffff
}

fn adler32(bytes: &[u8]) -> u32 {
    const MOD: u32 = 65521;
    let (mut a, mut b) = (1u32, 0u32);
    for chunk in bytes.chunks(5552) {
        for &x in chunk {
            a += x as u32;
            b += a;
        }
        a %= MOD;
        b %= MOD;
    }
    (b << 16) | a
}

fn chunk(out: &mut Vec<u8>, kind: &[u8; 4], data: &[u8]) {
    out.extend_from_slice(&(data.len() as u32).to_be_bytes());
    out.extend_from_slice(kind);
    out.extend_from_slice(data);
    let mut crc_input = Vec::with_capacity(4 + data.len());
    crc_input.extend_from_slice(kind);
    crc_input.extend_from_slice(data);
    out.extend_from_slice(&crc32(&crc_input).to_be_bytes());
}

/// Encode `w * h` RGBA pixels (row-major, 4 bytes each) as a PNG.
pub fn encode_rgba(w: u32, h: u32, rgba: &[u8]) -> Vec<u8> {
    assert_eq!(rgba.len(), (w * h * 4) as usize);

    // Raw stream: filter byte 0 + row bytes, per scanline.
    let row = (w * 4) as usize;
    let mut raw = Vec::with_capacity((row + 1) * h as usize);
    for y in 0..h as usize {
        raw.push(0);
        raw.extend_from_slice(&rgba[y * row..(y + 1) * row]);
    }

    // zlib: header, stored deflate blocks (<= 65535 bytes each), adler32.
    let mut z = Vec::with_capacity(raw.len() + raw.len() / 65535 * 5 + 16);
    z.push(0x78);
    z.push(0x01);
    let mut blocks = raw.chunks(65535).peekable();
    while let Some(block) = blocks.next() {
        z.push(if blocks.peek().is_none() { 1 } else { 0 });
        let len = block.len() as u16;
        z.extend_from_slice(&len.to_le_bytes());
        z.extend_from_slice(&(!len).to_le_bytes());
        z.extend_from_slice(block);
    }
    z.extend_from_slice(&adler32(&raw).to_be_bytes());

    let mut ihdr = Vec::with_capacity(13);
    ihdr.extend_from_slice(&w.to_be_bytes());
    ihdr.extend_from_slice(&h.to_be_bytes());
    ihdr.extend_from_slice(&[8, 6, 0, 0, 0]); // 8-bit RGBA, no interlace

    let mut out = Vec::with_capacity(z.len() + 128);
    out.extend_from_slice(&[137, 80, 78, 71, 13, 10, 26, 10]);
    chunk(&mut out, b"IHDR", &ihdr);
    chunk(&mut out, b"IDAT", &z);
    chunk(&mut out, b"IEND", &[]);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn well_formed_and_deterministic() {
        let px = [0xffu8, 0x00, 0x80, 0xff, 0x00, 0xff, 0x80, 0xff];
        let a = encode_rgba(2, 1, &px);
        let b = encode_rgba(2, 1, &px);
        assert_eq!(a, b);
        assert_eq!(&a[..8], &[137, 80, 78, 71, 13, 10, 26, 10]);
        // IHDR carries the dimensions.
        assert_eq!(&a[16..20], &2u32.to_be_bytes());
        assert_eq!(&a[20..24], &1u32.to_be_bytes());
        // The stored-deflate stream round-trips by hand: block header at
        // IDAT+2 (zlib header), then len/~len, then filter byte + pixels.
        let idat = 8 + 25 + 8; // signature + IHDR chunk + IDAT length+type
        assert_eq!(&a[idat..idat + 2], &[0x78, 0x01]);
        assert_eq!(a[idat + 2], 1, "single final stored block");
        let len = u16::from_le_bytes([a[idat + 3], a[idat + 4]]) as usize;
        assert_eq!(len, 1 + 8);
        assert_eq!(a[idat + 7], 0, "filter byte");
        assert_eq!(&a[idat + 8..idat + 8 + 8], &px);
    }

    #[test]
    fn crc_and_adler_vectors() {
        assert_eq!(crc32(b"123456789"), 0xcbf43926);
        assert_eq!(adler32(b"Wikipedia"), 0x11e60398);
    }
}
