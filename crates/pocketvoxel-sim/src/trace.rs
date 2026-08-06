//! `.vtrace` replay (voxelmon/SCHEMA.md §.vtrace): a line-oriented op
//! tape the Bun headless run records and every host replays.
//!
//! ```text
//! voxtrace 1
//! t <tick> <buttons>          # starts a tick; buttons = VOX_BTN that tick
//! o <code> <i32> ...          # one op, numeric args in order
//! s <code> <i32> <i32> <json-string>   # the string-bearing op forms
//! m <name>                    # checkpoint: render + hash here
//! ```
//!
//! Ticks are contiguous from 0 (validated). Within a tick block the ops
//! apply in order, then `Scene::tick` runs exactly once — at the first
//! checkpoint of the block, or when the next `t` line closes it — so a
//! checkpoint always renders the ticked state (docs/VOXEL.md §7: the frame
//! is a pure function of the tick index and the op stream).

use pocketvoxel_core::draw;
use pocketvoxel_core::pak::Pak;
use pocketvoxel_core::scene::Scene;

use crate::fnv::fnv1a64;
use crate::raster::{self, AtlasCache, Frame};

#[derive(Clone, Debug, PartialEq)]
pub enum Entry {
    Tick {
        tick: u32,
        buttons: u32,
    },
    Op {
        code: u32,
        args: Vec<i32>,
        s: Option<String>,
    },
    Mark(String),
}

/// Minimal JSON string literal parser (the `s` line payload).
fn parse_json_string(raw: &str) -> Result<String, String> {
    let raw = raw.trim();
    let inner = raw
        .strip_prefix('"')
        .and_then(|r| r.strip_suffix('"'))
        .ok_or_else(|| format!("string arg is not a JSON string: {raw}"))?;
    let mut out = String::with_capacity(inner.len());
    let mut chars = inner.chars();
    while let Some(c) = chars.next() {
        if c != '\\' {
            if c == '"' {
                return Err("unescaped quote inside string".into());
            }
            out.push(c);
            continue;
        }
        let e = chars.next().ok_or("dangling escape")?;
        match e {
            '"' => out.push('"'),
            '\\' => out.push('\\'),
            '/' => out.push('/'),
            'n' => out.push('\n'),
            'r' => out.push('\r'),
            't' => out.push('\t'),
            'b' => out.push('\u{8}'),
            'f' => out.push('\u{c}'),
            'u' => {
                let hex: String = (0..4).filter_map(|_| chars.next()).collect();
                if hex.len() != 4 {
                    return Err("truncated \\u escape".into());
                }
                let cp = u32::from_str_radix(&hex, 16).map_err(|_| "bad \\u escape")?;
                if (0xd800..0xdc00).contains(&cp) {
                    // High surrogate: require the paired \uXXXX low half.
                    let (bs, u) = (chars.next(), chars.next());
                    if bs != Some('\\') || u != Some('u') {
                        return Err("lone high surrogate".into());
                    }
                    let hex2: String = (0..4).filter_map(|_| chars.next()).collect();
                    let lo = u32::from_str_radix(&hex2, 16).map_err(|_| "bad \\u escape")?;
                    if !(0xdc00..0xe000).contains(&lo) {
                        return Err("invalid low surrogate".into());
                    }
                    let combined = 0x10000 + ((cp - 0xd800) << 10) + (lo - 0xdc00);
                    out.push(char::from_u32(combined).ok_or("invalid surrogate pair")?);
                } else {
                    out.push(char::from_u32(cp).ok_or("invalid \\u code point")?);
                }
            }
            other => return Err(format!("unknown escape \\{other}")),
        }
    }
    Ok(out)
}

pub fn parse(text: &str) -> Result<Vec<Entry>, String> {
    let mut lines = text.lines().enumerate();
    let header = loop {
        match lines.next() {
            Some((_, l)) if l.trim().is_empty() => continue,
            Some((_, l)) => break l.trim(),
            None => return Err("empty trace".into()),
        }
    };
    if header != "voxtrace 1" {
        return Err(format!("bad trace header: {header}"));
    }

    let mut out = Vec::new();
    for (no, line) in lines {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let err = |what: &str| format!("line {}: {what}: {line}", no + 1);
        let mut tok = line.split_whitespace();
        let kind = tok.next().unwrap();
        match kind {
            "t" => {
                let tick = tok
                    .next()
                    .and_then(|v| v.parse().ok())
                    .ok_or_else(|| err("bad tick"))?;
                let buttons = tok
                    .next()
                    .and_then(|v| v.parse().ok())
                    .ok_or_else(|| err("bad buttons"))?;
                out.push(Entry::Tick { tick, buttons });
            }
            "o" => {
                let code = tok
                    .next()
                    .and_then(|v| v.parse().ok())
                    .ok_or_else(|| err("bad op code"))?;
                let args = tok
                    .map(|v| v.parse::<i32>().map_err(|_| err("bad op arg")))
                    .collect::<Result<Vec<_>, _>>()?;
                out.push(Entry::Op {
                    code,
                    args,
                    s: None,
                });
            }
            "s" => {
                let code = tok
                    .next()
                    .and_then(|v| v.parse().ok())
                    .ok_or_else(|| err("bad op code"))?;
                let a0 = tok
                    .next()
                    .and_then(|v| v.parse().ok())
                    .ok_or_else(|| err("bad op arg"))?;
                let a1 = tok
                    .next()
                    .and_then(|v| v.parse().ok())
                    .ok_or_else(|| err("bad op arg"))?;
                // The string is the remainder of the line from the first quote.
                let rest = line
                    .find('"')
                    .map(|i| &line[i..])
                    .ok_or_else(|| err("missing string arg"))?;
                out.push(Entry::Op {
                    code,
                    args: vec![a0, a1],
                    s: Some(parse_json_string(rest).map_err(|e| err(&e))?),
                });
            }
            "m" => {
                let name = tok.next().ok_or_else(|| err("missing checkpoint name"))?;
                out.push(Entry::Mark(name.to_string()));
            }
            _ => return Err(err("unknown line kind")),
        }
    }
    Ok(out)
}

/// Interleaved-stereo PCM captured while a trace replays (`--wav`).
///
/// The sim is a VIRTUAL-CLOCK host, so it consumes exactly
/// `audioFramesForTick` frames per tick (contracts/spec/audio.ts §frame
/// contract). That is what makes the captured audio a pure function of the
/// tick index and the op stream — the same determinism story the pixel
/// goldens have.
pub struct Capture {
    pub rate: u32,
    pub pcm: Vec<i16>,
    scratch: Vec<i16>,
}

impl Capture {
    pub fn new(rate: u32) -> Self {
        Capture {
            rate,
            pcm: Vec::new(),
            scratch: Vec::new(),
        }
    }

    /// contracts/spec/audio.ts:149 audioFramesForTick — the frames the audio
    /// clock consumes during tick `tick`, exactly.
    fn frames_for_tick(&self, tick: u32) -> usize {
        let rate = self.rate as u64;
        (((tick as u64 + 1) * rate) / 60 - (tick as u64 * rate) / 60) as usize
    }

    fn pump(&mut self, scene: &mut Scene, pak: &Pak, tick: u32) {
        let frames = self.frames_for_tick(tick);
        self.scratch.clear();
        self.scratch.resize(frames * 2, 0);
        scene.render_audio(pak, frames, &mut self.scratch);
        self.pcm.extend_from_slice(&self.scratch);
    }
}

/// Replay a parsed trace through the real core + rasterizer. Returns the
/// checkpoint hashes in tape order; `shot` fires per checkpoint with the
/// rendered frame (for `--shots`), and `audio` captures the synth's PCM tick
/// by tick (for `--wav`).
///
/// `quality` is the ladder rung the replay stands on (`spec::quality_tier`),
/// the sim's stand-in for the `quality` op a real host emits at boot: the
/// tape is a GUEST op stream and the rung is a HOST decision, so it arrives
/// on the side, not in the tape. That is what lets one recorded trace produce
/// both the shipped goldens and the max-tier identity goldens.
pub fn run(
    pak: &Pak,
    cache: &AtlasCache,
    entries: &[Entry],
    quality: u8,
    mut audio: Option<&mut Capture>,
    mut shot: impl FnMut(&str, &Frame),
) -> Result<Vec<(String, u64)>, String> {
    let mut scene = Scene::new();
    scene.op(pocketvoxel_core::spec::op::QUALITY, &[quality as i32], None);
    if let Some(cap) = audio.as_deref() {
        scene.audio.set_rate(cap.rate);
    }
    let mut hashes = Vec::new();
    let mut current: Option<u32> = None;
    let mut ticked = false;

    // Closing a tick block is: this tick's audio, then the scene clock. Both
    // happen exactly once per tick, whether a checkpoint closed the block or
    // the next `t` line did.
    macro_rules! close {
        ($tick:expr) => {
            if let Some(cap) = audio.as_deref_mut() {
                cap.pump(&mut scene, pak, $tick);
            }
            scene.tick();
        };
    }

    for entry in entries {
        match entry {
            Entry::Tick { tick, .. } => {
                match current {
                    None => {
                        if *tick != 0 {
                            return Err(format!("ticks must start at 0, got {tick}"));
                        }
                    }
                    Some(prev) => {
                        if *tick != prev + 1 {
                            return Err(format!("non-contiguous tick {tick} after {prev}"));
                        }
                        if !ticked {
                            close!(prev);
                        }
                    }
                }
                current = Some(*tick);
                ticked = false;
            }
            Entry::Op { code, args, s } => {
                if current.is_none() {
                    return Err("op before the first tick".into());
                }
                scene.op(*code, args, s.as_deref());
            }
            Entry::Mark(name) => {
                let Some(tick) = current else {
                    return Err("checkpoint before the first tick".into());
                };
                if !ticked {
                    close!(tick);
                    ticked = true;
                }
                let list = draw::build(&scene, pak);
                // Composition probe (VOXEL_TRIS=1): what the frame's
                // triangles are spent on, per mesh kind, at this rung's
                // dials — the measuring tool for uniform-dial budgeting.
                if std::env::var_os("VOXEL_TRIS").is_some() {
                    let mut kinds = [0u32; 16];
                    let mut stamps = 0u32;
                    let mut cards = 0u32;
                    for item in &list.items {
                        match item {
                            draw::Item::ChunkMesh { kind, mesh, .. } => {
                                kinds[*kind as usize] += u32::from(mesh.index_count) / 3;
                            }
                            draw::Item::StampMesh { mesh, .. } => {
                                stamps += u32::from(mesh.index_count) / 3;
                            }
                            draw::Item::Card { .. } => cards += 2,
                            _ => {}
                        }
                    }
                    let names = [
                        "terrain", "bake", "keep", "hull", "coarse", "box", "water", "grass",
                        "flower",
                    ];
                    let mut line = format!("tris {name}:");
                    for (k, label) in names.iter().enumerate() {
                        if kinds[k] > 0 {
                            line.push_str(&format!(" {label} {}", kinds[k]));
                        }
                    }
                    eprintln!("{line} stamps {stamps} cards {cards}");
                }
                let frame = raster::render(&list, pak, cache);
                hashes.push((name.clone(), fnv1a64(&frame.rgba_bytes())));
                shot(name, &frame);
            }
        }
    }
    // The tape's last block gets its tick too, so `--wav` covers every tick
    // the tape states and not one less.
    if let Some(tick) = current
        && !ticked
    {
        close!(tick);
    }
    Ok(hashes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_the_schema_forms() {
        let text =
            "voxtrace 1\nt 0 0\no 12 1024 1024\ns 52 1 14 \"HI\\nYOU\"\nm boot\nt 1 16\nm next\n";
        let entries = parse(text).unwrap();
        assert_eq!(entries.len(), 6);
        assert_eq!(
            entries[0],
            Entry::Tick {
                tick: 0,
                buttons: 0
            }
        );
        assert_eq!(
            entries[2],
            Entry::Op {
                code: 52,
                args: vec![1, 14],
                s: Some("HI\nYOU".to_string())
            }
        );
        assert_eq!(entries[3], Entry::Mark("boot".to_string()));
        assert!(parse("voxtrace 2\n").is_err(), "unknown version");
        assert!(parse("t 0 0\n").is_err(), "missing header");
        assert!(parse("voxtrace 1\nq zzz\n").is_err(), "unknown line kind");
    }

    #[test]
    fn json_string_escapes() {
        assert_eq!(parse_json_string(r#""a b""#).unwrap(), "a b");
        assert_eq!(parse_json_string(r#""a\"b\\c\n""#).unwrap(), "a\"b\\c\n");
        assert_eq!(parse_json_string(r#""Aé""#).unwrap(), "Aé");
        assert_eq!(parse_json_string(r#""😀""#).unwrap(), "😀");
        assert!(parse_json_string(r#""\ud83d""#).is_err(), "lone surrogate");
        assert!(parse_json_string("no quotes").is_err());
    }
}
