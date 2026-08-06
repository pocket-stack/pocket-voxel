//! pocketvoxel-sim — the headless Pocket Voxel host (docs/VOXEL.md §7.4):
//! replays a recorded `.vtrace` op tape through the real presentation core
//! and the software rasterizer into deterministic frame hashes.
//!
//! ```text
//! pocketvoxel-sim <pak> --trace <file> [--shots dir] [--hashes file] [--assert]
//!                       [--wav file] [--rate hz] [--quality tier]
//! pocketvoxel-sim <pak> --validate
//! ```
//!
//! `--validate` loads the pak through the full reader (every range check)
//! and prints a one-line summary — the cook test's smoke gate.
//!
//! `--quality` names the ladder rung the replay stands on — `psp` (the
//! shipped default), `vita`, `desktop`, or the rung's number. The sim is the
//! host here, and the rung is a host decision: the same recorded tape
//! produces the shipped goldens at `psp` and the pre-ladder identity goldens
//! at `desktop` (voxel-spec.ts §quality ladder).
//!
//! Without `--assert`, hashes print to stdout (and write to `--hashes` when
//! given) as `<name> <hex>` lines — the committed golden format
//! (`tests/goldens/voxel/*.hashes`). With `--assert`, computed hashes
//! compare against the `--hashes` file and any mismatch exits nonzero.
//! `--shots` writes per-checkpoint PNGs locally; PNGs are never committed
//! (the pak is ROM-derived — docs/VOXEL.md §1).
//!
//! `--wav` renders the audio the tape's ops produce — the real core synth,
//! pumped for exactly `audioFramesForTick` frames per tick — and writes it as
//! a RIFF/WAVE file, printing its peak and RMS. That is how the synth is
//! listened to and measured without hardware.

#[cfg(test)]
mod e2e;
mod fnv;
mod png;
mod raster;
mod trace;
mod wav;

use std::path::PathBuf;
use std::process::ExitCode;

use pocketvoxel_core::pak::{self, AlignedBlob};

struct Args {
    pak: PathBuf,
    trace: Option<PathBuf>,
    shots: Option<PathBuf>,
    hashes: Option<PathBuf>,
    assert: bool,
    validate: bool,
    wav: Option<PathBuf>,
    rate: u32,
    quality: u8,
}

fn usage() -> ! {
    eprintln!(
        "usage: pocketvoxel-sim <pak> --trace <file> [--shots dir] [--hashes file] [--assert] [--wav file] [--rate hz] [--quality psp|vita|desktop]\n       pocketvoxel-sim <pak> --validate"
    );
    std::process::exit(2);
}

/// A `--quality` argument: a rung name from `spec::quality_tier` or its
/// number. Names are what scripts and goldens should say; the number is the
/// escape hatch for a rung this binary is older than.
fn parse_quality(raw: &str) -> Option<u8> {
    use pocketvoxel_core::spec::{QUALITY, quality_tier};
    let tier = match raw {
        "psp" => quality_tier::PSP,
        "vita" => quality_tier::VITA,
        "desktop" => quality_tier::DESKTOP,
        n => n.parse().ok()?,
    };
    ((tier as usize) < QUALITY.len()).then_some(tier)
}

fn parse_args() -> Args {
    let mut pak = None;
    let mut trace = None;
    let mut shots = None;
    let mut hashes = None;
    let mut assert = false;
    let mut validate = false;
    let mut wav = None;
    let mut rate = 44100u32;
    let mut quality = pocketvoxel_core::spec::QUALITY_TIER_DEFAULT;
    let mut it = std::env::args().skip(1);
    while let Some(arg) = it.next() {
        match arg.as_str() {
            "--trace" => trace = Some(PathBuf::from(it.next().unwrap_or_else(|| usage()))),
            "--shots" => shots = Some(PathBuf::from(it.next().unwrap_or_else(|| usage()))),
            "--hashes" => hashes = Some(PathBuf::from(it.next().unwrap_or_else(|| usage()))),
            "--wav" => wav = Some(PathBuf::from(it.next().unwrap_or_else(|| usage()))),
            "--rate" => {
                rate = it
                    .next()
                    .and_then(|v| v.parse().ok())
                    .unwrap_or_else(|| usage())
            }
            "--quality" => {
                let raw = it.next().unwrap_or_else(|| usage());
                quality = parse_quality(&raw).unwrap_or_else(|| {
                    eprintln!("--quality: unknown tier {raw:?} (psp|vita|desktop)");
                    std::process::exit(2);
                })
            }
            "--assert" => assert = true,
            "--validate" => validate = true,
            _ if pak.is_none() && !arg.starts_with('-') => pak = Some(PathBuf::from(arg)),
            _ => usage(),
        }
    }
    let Some(pak) = pak else { usage() };
    if !validate && trace.is_none() {
        usage()
    }
    if assert && hashes.is_none() {
        eprintln!("--assert needs --hashes <file> to compare against");
        std::process::exit(2);
    }
    if 44100 % rate != 0 {
        eprintln!("--rate must divide 44100 (contracts/spec/audio.ts AUDIO_RATES)");
        std::process::exit(2);
    }
    Args {
        pak,
        trace,
        shots,
        hashes,
        assert,
        validate,
        wav,
        rate,
        quality,
    }
}

fn main() -> ExitCode {
    let args = parse_args();
    match run(&args) {
        Ok(ok) => {
            if ok {
                ExitCode::SUCCESS
            } else {
                ExitCode::FAILURE
            }
        }
        Err(e) => {
            eprintln!("pocketvoxel-sim: {e}");
            ExitCode::FAILURE
        }
    }
}

fn run(args: &Args) -> Result<bool, String> {
    let raw = std::fs::read(&args.pak).map_err(|e| format!("{}: {e}", args.pak.display()))?;
    // The reader borrows pools in place and (correctly) rejects misaligned
    // ones; a Vec<u8> from the filesystem carries no alignment guarantee.
    let blob = AlignedBlob::from_bytes(&raw);
    let pak = pak::read(blob.bytes()).map_err(|e| format!("{}: {e}", args.pak.display()))?;

    if args.validate {
        println!(
            "valid: {} maps, {} chunks, {} verts, {} indices, {} atlases, {} palettes, {} stamps, {} glyphs, {} game bytes",
            pak.maps.len(),
            pak.chunks.len(),
            pak.verts.len(),
            pak.indices.len(),
            pak.atlases.len(),
            pak.palettes.len(),
            pak.stamps.len(),
            pak.charmap.len(),
            pak.game.len(),
        );
        return Ok(true);
    }

    let cache = raster::AtlasCache::new(&pak);

    let trace_path = args.trace.as_ref().unwrap();
    let text = std::fs::read_to_string(trace_path)
        .map_err(|e| format!("{}: {e}", trace_path.display()))?;
    let entries = trace::parse(&text)?;

    if let Some(dir) = &args.shots {
        std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    }
    let shots = args.shots.clone();
    let mut capture = args.wav.as_ref().map(|_| trace::Capture::new(args.rate));
    let hashes = trace::run(
        &pak,
        &cache,
        &entries,
        args.quality,
        capture.as_mut(),
        |name, frame| {
            if let Some(dir) = &shots {
                let bytes =
                    png::encode_rgba(raster::W as u32, raster::H as u32, &frame.rgba_bytes());
                let path = dir.join(format!("{name}.png"));
                if let Err(e) = std::fs::write(&path, bytes) {
                    eprintln!("pocketvoxel-sim: {}: {e}", path.display());
                }
            }
        },
    )?;

    if let (Some(path), Some(capture)) = (&args.wav, &capture) {
        let bytes = wav::encode(&capture.pcm, capture.rate, 2);
        std::fs::write(path, bytes).map_err(|e| format!("{}: {e}", path.display()))?;
        let (peak, rms, peak_pct, rms_pct) = wav::levels(&capture.pcm);
        println!(
            "wav {} {} frames {} Hz peak {peak} ({:.1}%) rms {rms:.0} ({:.1}%)",
            path.display(),
            capture.pcm.len() / 2,
            capture.rate,
            peak_pct * 100.0,
            rms_pct * 100.0,
        );
    }

    let report: String = hashes
        .iter()
        .map(|(name, hash)| format!("{name} {hash:016x}\n"))
        .collect();

    if args.assert {
        let golden_path = args.hashes.as_ref().unwrap();
        let golden = std::fs::read_to_string(golden_path)
            .map_err(|e| format!("{}: {e}", golden_path.display()))?;
        let mut want = std::collections::BTreeMap::new();
        for line in golden.lines().filter(|l| !l.trim().is_empty()) {
            let mut tok = line.split_whitespace();
            let (Some(name), Some(hex)) = (tok.next(), tok.next()) else {
                return Err(format!("bad golden line: {line}"));
            };
            let value =
                u64::from_str_radix(hex, 16).map_err(|_| format!("bad golden hash: {line}"))?;
            want.insert(name.to_string(), value);
        }
        let mut ok = true;
        for (name, hash) in &hashes {
            match want.get(name) {
                Some(&expected) if expected == *hash => {}
                Some(&expected) => {
                    eprintln!("MISMATCH {name}: computed {hash:016x}, golden {expected:016x}");
                    ok = false;
                }
                None => {
                    eprintln!("MISSING golden for checkpoint {name} (computed {hash:016x})");
                    ok = false;
                }
            }
        }
        if hashes.len() != want.len() {
            eprintln!(
                "checkpoint count mismatch: trace has {}, goldens have {}",
                hashes.len(),
                want.len()
            );
            ok = false;
        }
        print!("{report}");
        Ok(ok)
    } else {
        print!("{report}");
        if let Some(path) = &args.hashes {
            std::fs::write(path, &report).map_err(|e| format!("{}: {e}", path.display()))?;
        }
        Ok(true)
    }
}
