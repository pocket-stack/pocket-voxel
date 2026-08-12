//! Deterministic browser-local packaging for Pocket Voxel's console hosts.
//!
//! The CPU executables are ROM-independent release templates built from this
//! repository. The browser cooker supplies the one ROM-derived `VXPK`; this
//! module assembles the PSP PBP/install tree or Vita VPK without uploading it.

use wasm_bindgen::prelude::*;

use miniz_oxide::deflate::compress_to_vec;

const VXPK_MAGIC: &[u8; 4] = b"VXPK";
const PBP_MAGIC: u32 = 0x5042_5000;
const PBP_VERSION: u32 = 0x0001_0000;
const ZIP_LOCAL_FILE: u32 = 0x0403_4b50;
const ZIP_CENTRAL_FILE: u32 = 0x0201_4b50;
const ZIP_END: u32 = 0x0605_4b50;
const ZIP_VERSION: u16 = 20;
const ZIP_DOS_DATE_1980_01_01: u16 = 0x0021;

#[derive(Clone, Copy)]
enum SfoValue<'a> {
    Number(u32),
    Text(&'a str),
}

struct ZipEntry<'a> {
    name: &'static str,
    bytes: &'a [u8],
}

struct ZipCentral {
    name: &'static str,
    crc: u32,
    size: u32,
    compressed_size: u32,
    method: u16,
    local_offset: u32,
}

fn put_u16(out: &mut Vec<u8>, value: u16) {
    out.extend_from_slice(&value.to_le_bytes());
}

fn put_u32(out: &mut Vec<u8>, value: u32) {
    out.extend_from_slice(&value.to_le_bytes());
}

fn checked_u16(value: usize, what: &str) -> Result<u16, String> {
    u16::try_from(value).map_err(|_| format!("{what} is too large"))
}

fn checked_u32(value: usize, what: &str) -> Result<u32, String> {
    u32::try_from(value).map_err(|_| format!("{what} is too large"))
}

fn align4(value: usize) -> usize {
    (value + 3) & !3
}

fn build_sfo(entries: &[(&str, SfoValue<'_>)]) -> Result<Vec<u8>, String> {
    let mut index = Vec::with_capacity(entries.len() * 16);
    let mut keys = Vec::new();
    let mut values = Vec::new();

    for (key, value) in entries {
        if key.is_empty() || key.as_bytes().contains(&0) || !key.is_ascii() {
            return Err(format!("invalid SFO key {key:?}"));
        }
        let key_offset = checked_u16(keys.len(), "SFO key table")?;
        keys.extend_from_slice(key.as_bytes());
        keys.push(0);

        let data_offset = checked_u32(values.len(), "SFO value table")?;
        let (kind, value_size, total_size) = match value {
            SfoValue::Number(number) => {
                values.extend_from_slice(&number.to_le_bytes());
                (4_u8, 4_u32, 4_u32)
            }
            SfoValue::Text(text) => {
                if text.as_bytes().contains(&0) {
                    return Err(format!("SFO value for {key} contains NUL"));
                }
                let value_size = checked_u32(text.len() + 1, "SFO string")?;
                let total_size = checked_u32(align4(text.len() + 1), "SFO string")?;
                values.extend_from_slice(text.as_bytes());
                values.push(0);
                values.resize(values.len() + total_size as usize - value_size as usize, 0);
                (2_u8, value_size, total_size)
            }
        };

        put_u16(&mut index, key_offset);
        index.push(4);
        index.push(kind);
        put_u32(&mut index, value_size);
        put_u32(&mut index, total_size);
        put_u32(&mut index, data_offset);
    }

    let key_start = 20 + index.len();
    let value_start = align4(key_start + keys.len());
    let mut out = Vec::with_capacity(value_start + values.len());
    put_u32(&mut out, 0x4653_5000); // "\0PSF"
    put_u32(&mut out, 0x0000_0101);
    put_u32(&mut out, checked_u32(key_start, "SFO key offset")?);
    put_u32(&mut out, checked_u32(value_start, "SFO value offset")?);
    put_u32(&mut out, checked_u32(entries.len(), "SFO entry count")?);
    out.extend_from_slice(&index);
    out.extend_from_slice(&keys);
    out.resize(value_start, 0);
    out.extend_from_slice(&values);
    Ok(out)
}

fn psp_sfo() -> Result<Vec<u8>, String> {
    build_sfo(&[
        ("BOOTABLE", SfoValue::Number(1)),
        ("CATEGORY", SfoValue::Text("MG")),
        ("DISC_ID", SfoValue::Text("PVXL00001")),
        ("DISC_VERSION", SfoValue::Text("1.00")),
        ("MEMSIZE", SfoValue::Number(1)),
        ("PARENTAL_LEVEL", SfoValue::Number(1)),
        ("PSP_SYSTEM_VER", SfoValue::Text("1.00")),
        ("REGION", SfoValue::Number(0x8000)),
        ("TITLE", SfoValue::Text("VOXELMON")),
    ])
}

fn validate_nonempty(bytes: &[u8], label: &str) -> Result<(), String> {
    if bytes.is_empty() {
        Err(format!("{label} template is empty"))
    } else {
        Ok(())
    }
}

fn validate_pak(pak: &[u8]) -> Result<(), String> {
    if pak.len() < 16 || pak.get(..4) != Some(VXPK_MAGIC.as_slice()) {
        return Err("cooked world is not a VXPK".into());
    }
    if u16::from_le_bytes(pak[4..6].try_into().unwrap()) != 8 {
        return Err("cooked world uses an unsupported VXPK version".into());
    }
    if u16::from_le_bytes(pak[6..8].try_into().unwrap()) != 9 {
        return Err("cooked world has the wrong VXPK section count".into());
    }
    if u32::from_le_bytes(pak[8..12].try_into().unwrap()) as usize != pak.len() {
        return Err("cooked world length disagrees with its VXPK header".into());
    }
    if pak[12..16] != [0; 4] {
        return Err("cooked world has a non-zero VXPK reserved word".into());
    }
    checked_u32(pak.len(), "VXPK")?;
    Ok(())
}

fn build_pbp(prx: &[u8], icon0: &[u8], pic1: &[u8]) -> Result<Vec<u8>, String> {
    validate_nonempty(prx, "PSP PRX")?;
    validate_nonempty(icon0, "PSP ICON0")?;
    validate_nonempty(pic1, "PSP PIC1")?;
    let sfo = psp_sfo()?;
    let sections: [&[u8]; 8] = [
        &sfo,
        icon0,
        &[], // ICON1.PMF
        &[], // PIC0.PNG
        pic1,
        &[], // SND0.AT3
        prx,
        &[], // DATA.PSAR
    ];
    let total = 40_usize
        .checked_add(sections.iter().map(|section| section.len()).sum::<usize>())
        .ok_or_else(|| "PSP EBOOT size overflow".to_string())?;
    checked_u32(total, "PSP EBOOT")?;
    let mut out = Vec::with_capacity(total);
    put_u32(&mut out, PBP_MAGIC);
    put_u32(&mut out, PBP_VERSION);
    let mut offset = 40_usize;
    for section in sections {
        put_u32(&mut out, checked_u32(offset, "PBP section offset")?);
        offset += section.len();
    }
    for section in sections {
        out.extend_from_slice(section);
    }
    Ok(out)
}

fn crc32(bytes: &[u8]) -> u32 {
    let mut crc = 0xffff_ffff_u32;
    for &byte in bytes {
        crc ^= u32::from(byte);
        for _ in 0..8 {
            crc = (crc >> 1) ^ (0xedb8_8320 & (0_u32.wrapping_sub(crc & 1)));
        }
    }
    !crc
}

fn build_zip(entries: &[ZipEntry<'_>]) -> Result<Vec<u8>, String> {
    if entries.is_empty() {
        return Err("ZIP has no entries".into());
    }
    let entry_count = checked_u16(entries.len(), "ZIP entry count")?;
    let input_bytes = entries.iter().try_fold(0_usize, |sum, entry| {
        if entry.name.is_empty()
            || !entry.name.is_ascii()
            || entry.name.starts_with('/')
            || entry
                .name
                .split('/')
                .any(|part| part.is_empty() || part == "." || part == "..")
        {
            return Err(format!("unsafe ZIP path {:?}", entry.name));
        }
        let next = sum
            .checked_add(entry.bytes.len())
            .ok_or_else(|| "ZIP input size overflow".to_string())?;
        checked_u32(entry.bytes.len(), "ZIP entry")?;
        checked_u16(entry.name.len(), "ZIP path")?;
        Ok(next)
    })?;
    let mut out = Vec::with_capacity(input_bytes + entries.len() * 96 + 22);
    let mut central = Vec::with_capacity(entries.len());

    for entry in entries {
        let name = entry.name.as_bytes();
        let crc = crc32(entry.bytes);
        let size = checked_u32(entry.bytes.len(), "ZIP entry")?;
        let compressed = compress_to_vec(entry.bytes, 9);
        let (method, payload) = if compressed.len() < entry.bytes.len() {
            (8_u16, compressed.as_slice())
        } else {
            (0_u16, entry.bytes)
        };
        let compressed_size = checked_u32(payload.len(), "compressed ZIP entry")?;
        let local_offset = checked_u32(out.len(), "ZIP local header offset")?;
        put_u32(&mut out, ZIP_LOCAL_FILE);
        put_u16(&mut out, ZIP_VERSION);
        put_u16(&mut out, 0); // ASCII names, no data descriptor
        put_u16(&mut out, method);
        put_u16(&mut out, 0);
        put_u16(&mut out, ZIP_DOS_DATE_1980_01_01);
        put_u32(&mut out, crc);
        put_u32(&mut out, compressed_size);
        put_u32(&mut out, size);
        put_u16(&mut out, checked_u16(name.len(), "ZIP path")?);
        put_u16(&mut out, 0);
        out.extend_from_slice(name);
        out.extend_from_slice(payload);
        central.push(ZipCentral {
            name: entry.name,
            crc,
            size,
            compressed_size,
            method,
            local_offset,
        });
    }

    let central_offset = checked_u32(out.len(), "ZIP central directory offset")?;
    for entry in &central {
        let name = entry.name.as_bytes();
        put_u32(&mut out, ZIP_CENTRAL_FILE);
        put_u16(&mut out, ZIP_VERSION);
        put_u16(&mut out, ZIP_VERSION);
        put_u16(&mut out, 0);
        put_u16(&mut out, entry.method);
        put_u16(&mut out, 0);
        put_u16(&mut out, ZIP_DOS_DATE_1980_01_01);
        put_u32(&mut out, entry.crc);
        put_u32(&mut out, entry.compressed_size);
        put_u32(&mut out, entry.size);
        put_u16(&mut out, checked_u16(name.len(), "ZIP path")?);
        put_u16(&mut out, 0);
        put_u16(&mut out, 0);
        put_u16(&mut out, 0);
        put_u16(&mut out, 0);
        put_u32(&mut out, 0);
        put_u32(&mut out, entry.local_offset);
        out.extend_from_slice(name);
    }
    let central_size = checked_u32(out.len() - central_offset as usize, "ZIP central directory")?;
    put_u32(&mut out, ZIP_END);
    put_u16(&mut out, 0);
    put_u16(&mut out, 0);
    put_u16(&mut out, entry_count);
    put_u16(&mut out, entry_count);
    put_u32(&mut out, central_size);
    put_u32(&mut out, central_offset);
    put_u16(&mut out, 0);
    checked_u32(out.len(), "ZIP archive")?;
    Ok(out)
}

fn psp_package(
    prx: &[u8],
    icon0: &[u8],
    pic1: &[u8],
    notices: &[u8],
    pak: &[u8],
) -> Result<Vec<u8>, String> {
    validate_pak(pak)?;
    validate_nonempty(notices, "third-party notices")?;
    let eboot = build_pbp(prx, icon0, pic1)?;
    build_zip(&[
        ZipEntry {
            name: "PSP/GAME/VOXELMON/EBOOT.PBP",
            bytes: &eboot,
        },
        ZipEntry {
            name: "PSP/GAME/VOXELMON/voxelmon.vxpak",
            bytes: pak,
        },
        ZipEntry {
            name: "PSP/GAME/VOXELMON/THIRD_PARTY_NOTICES.txt",
            bytes: notices,
        },
    ])
}

#[allow(clippy::too_many_arguments)]
fn vita_package(
    eboot: &[u8],
    sfo: &[u8],
    icon0: &[u8],
    background: &[u8],
    startup: &[u8],
    template_xml: &[u8],
    notices: &[u8],
    pak: &[u8],
) -> Result<Vec<u8>, String> {
    validate_pak(pak)?;
    for (bytes, label) in [
        (eboot, "Vita eboot"),
        (sfo, "Vita param.sfo"),
        (icon0, "Vita icon0"),
        (background, "Vita LiveArea background"),
        (startup, "Vita LiveArea startup"),
        (template_xml, "Vita LiveArea template"),
        (notices, "third-party notices"),
    ] {
        validate_nonempty(bytes, label)?;
    }
    build_zip(&[
        ZipEntry {
            name: "sce_sys/param.sfo",
            bytes: sfo,
        },
        ZipEntry {
            name: "eboot.bin",
            bytes: eboot,
        },
        ZipEntry {
            name: "sce_sys/icon0.png",
            bytes: icon0,
        },
        ZipEntry {
            name: "sce_sys/livearea/contents/bg.png",
            bytes: background,
        },
        ZipEntry {
            name: "sce_sys/livearea/contents/startup.png",
            bytes: startup,
        },
        ZipEntry {
            name: "sce_sys/livearea/contents/template.xml",
            bytes: template_xml,
        },
        ZipEntry {
            name: "voxelmon.vxpak",
            bytes: pak,
        },
        ZipEntry {
            name: "THIRD_PARTY_NOTICES.txt",
            bytes: notices,
        },
    ])
}

fn js_error(message: String) -> JsValue {
    JsValue::from_str(&message)
}

/// Assemble a PSP memory-stick ZIP containing a newly built EBOOT.PBP and the
/// cooked world beside it. The PRX and artwork are ROM-independent templates.
#[wasm_bindgen]
pub fn build_psp_install_zip(
    prx: &[u8],
    icon0: &[u8],
    pic1: &[u8],
    notices: &[u8],
    pak: &[u8],
) -> Result<Vec<u8>, JsValue> {
    psp_package(prx, icon0, pic1, notices, pak).map_err(js_error)
}

/// Assemble a Vita VPK from a ROM-independent SELF/SFO/LiveArea template and
/// the browser-cooked world.
#[wasm_bindgen]
#[allow(clippy::too_many_arguments)]
pub fn build_vita_vpk(
    eboot: &[u8],
    sfo: &[u8],
    icon0: &[u8],
    background: &[u8],
    startup: &[u8],
    template_xml: &[u8],
    notices: &[u8],
    pak: &[u8],
) -> Result<Vec<u8>, JsValue> {
    vita_package(
        eboot,
        sfo,
        icon0,
        background,
        startup,
        template_xml,
        notices,
        pak,
    )
    .map_err(js_error)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pak() -> Vec<u8> {
        let mut bytes = b"VXPK".to_vec();
        bytes.extend_from_slice(&8_u16.to_le_bytes());
        bytes.extend_from_slice(&9_u16.to_le_bytes());
        bytes.extend_from_slice(&32_u32.to_le_bytes());
        bytes.extend_from_slice(&0_u32.to_le_bytes());
        bytes.resize(32, 0x5a);
        bytes
    }

    fn read_u32(bytes: &[u8], offset: usize) -> u32 {
        u32::from_le_bytes(bytes[offset..offset + 4].try_into().unwrap())
    }

    #[test]
    fn psp_sfo_matches_the_shipping_contract() {
        let sfo = psp_sfo().unwrap();
        assert_eq!(sfo.len(), 316);
        assert_eq!(&sfo[..4], b"\0PSF");
        assert_eq!(read_u32(&sfo, 16), 9);
        assert!(sfo.windows(8).any(|window| window == b"MEMSIZE\0"));
        assert!(sfo.windows(9).any(|window| window == b"VOXELMON\0"));
    }

    #[test]
    fn psp_pbp_offsets_cover_all_eight_sections() {
        let sfo = psp_sfo().unwrap();
        let prx = b"PRX-template";
        let icon = b"icon";
        let pic = b"picture";
        let pbp = build_pbp(prx, icon, pic).unwrap();
        assert_eq!(read_u32(&pbp, 0), PBP_MAGIC);
        assert_eq!(read_u32(&pbp, 4), PBP_VERSION);
        let offsets: Vec<_> = (0..8).map(|index| read_u32(&pbp, 8 + index * 4)).collect();
        assert_eq!(offsets[0], 40);
        assert_eq!(offsets[1], 40 + sfo.len() as u32);
        assert_eq!(offsets[2], offsets[1] + icon.len() as u32);
        assert_eq!(offsets[2], offsets[3]);
        assert_eq!(offsets[3], offsets[4]);
        assert_eq!(offsets[5], offsets[4] + pic.len() as u32);
        assert_eq!(offsets[5], offsets[6]);
        assert_eq!(offsets[7], pbp.len() as u32);
    }

    #[test]
    fn psp_zip_contains_the_install_tree() {
        let archive = psp_package(b"PRX", b"ICON", b"PIC", b"NOTICES", &pak()).unwrap();
        assert_eq!(read_u32(&archive, 0), ZIP_LOCAL_FILE);
        for name in [
            b"PSP/GAME/VOXELMON/EBOOT.PBP".as_slice(),
            b"PSP/GAME/VOXELMON/voxelmon.vxpak",
            b"PSP/GAME/VOXELMON/THIRD_PARTY_NOTICES.txt",
            b"NOTICES",
        ] {
            assert!(archive.windows(name.len()).any(|window| window == name));
        }
        assert_eq!(read_u32(&archive, archive.len() - 22), ZIP_END);
    }

    #[test]
    fn vita_vpk_contains_the_runtime_and_cooked_world() {
        let archive = vita_package(
            b"SELF",
            b"SFO",
            b"ICON",
            b"BG",
            b"START",
            b"XML",
            b"NOTICES",
            &pak(),
        )
        .unwrap();
        for name in [
            b"eboot.bin".as_slice(),
            b"sce_sys/param.sfo",
            b"sce_sys/icon0.png",
            b"sce_sys/livearea/contents/bg.png",
            b"sce_sys/livearea/contents/startup.png",
            b"sce_sys/livearea/contents/template.xml",
            b"voxelmon.vxpak",
            b"THIRD_PARTY_NOTICES.txt",
            b"NOTICES",
        ] {
            assert!(archive.windows(name.len()).any(|window| window == name));
        }
    }

    #[test]
    fn rejects_non_vxpk_content() {
        let error = psp_package(b"PRX", b"ICON", b"PIC", b"NOTICES", b"ROM").unwrap_err();
        assert_eq!(error, "cooked world is not a VXPK");
        let mut wrong_version = pak();
        wrong_version[4] = 7;
        assert_eq!(
            validate_pak(&wrong_version).unwrap_err(),
            "cooked world uses an unsupported VXPK version"
        );
        let mut wrong_length = pak();
        wrong_length.push(0);
        assert_eq!(
            validate_pak(&wrong_length).unwrap_err(),
            "cooked world length disagrees with its VXPK header"
        );
    }
}
