#[cfg(target_os = "linux")]
mod device;
#[cfg(target_os = "linux")]
mod surface;

#[cfg(target_os = "linux")]
fn main() -> anyhow::Result<()> {
    use std::path::PathBuf;
    use std::time::{Duration, Instant};

    use anyhow::{Context, bail};
    use pocket_mod::Guest;
    use pocketvoxel_core::draw;
    use pocketvoxel_core::pak::{self, AlignedBlob};
    use pocketvoxel_core::spec::{TICK_HZ, VIEW_H, VIEW_W};
    use pocketvoxel_sim::raster;

    const AUDIO_RATE: u32 = 11_025;
    const TICKS_PER_PRESENT: u32 = 2;

    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();

    let mut pak_path: Option<PathBuf> = None;
    let mut bundle_path: Option<PathBuf> = None;
    let mut framebuffer_path = PathBuf::from("/dev/fb_lcd");
    let mut input_path = PathBuf::from("/dev/input/cardputer-zero-internal");
    let mut max_ticks: Option<u32> = None;
    let mut no_audio = false;
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--pak" => pak_path = args.next().map(PathBuf::from),
            "--bundle" => bundle_path = args.next().map(PathBuf::from),
            "--framebuffer" => {
                framebuffer_path = args
                    .next()
                    .map(PathBuf::from)
                    .context("--framebuffer needs a path")?
            }
            "--input" => {
                input_path = args
                    .next()
                    .map(PathBuf::from)
                    .context("--input needs a path")?
            }
            "--frames" => {
                max_ticks = Some(
                    args.next()
                        .context("--frames needs a count")?
                        .parse()
                        .context("invalid --frames count")?,
                )
            }
            "--no-audio" => no_audio = true,
            "--help" | "-h" => {
                println!(
                    "usage: pocketvoxel-cardputer [--pak path] [--bundle path] [--framebuffer path] [--input path] [--frames ticks] [--no-audio]"
                );
                return Ok(());
            }
            other => bail!("unknown argument {other:?}"),
        }
    }
    let asset_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(PathBuf::from))
        .unwrap_or_else(|| PathBuf::from("/usr/share/pocket-voxel"));
    let pak_path = pak_path.unwrap_or_else(|| asset_dir.join("voxelmon.vxpak"));
    let bundle_path = bundle_path.unwrap_or_else(|| asset_dir.join("game.js"));

    let raw =
        std::fs::read(&pak_path).with_context(|| format!("reading {}", pak_path.display()))?;
    let blob = AlignedBlob::from_bytes(&raw);
    let pak = pak::read(blob.bytes())
        .map_err(|error| anyhow::anyhow!("{}: {error}", pak_path.display()))?;
    let bundle = std::fs::read_to_string(&bundle_path)
        .with_context(|| format!("reading {}", bundle_path.display()))?;
    let cache = raster::AtlasCache::new(&pak);

    let guest = Guest::new()?;
    let host = surface::mount(&guest, pak.game, pak.audio)?;
    guest.eval("voxelmon", &bundle)?;
    if !guest.has_frame() {
        bail!("game bundle installed no frame() function");
    }

    let mut framebuffer =
        device::Framebuffer::open(&framebuffer_path, VIEW_W as usize, VIEW_H as usize)?;
    let (panel_w, panel_h, fit) = framebuffer.geometry();
    log::info!(
        "cardputer: panel {}x{} RGB565, logical {}x{} -> {}x{} +({}, {})",
        panel_w,
        panel_h,
        VIEW_W,
        VIEW_H,
        fit.draw_w,
        fit.draw_h,
        fit.offset_x,
        fit.offset_y,
    );
    let mut keyboard = device::Keyboard::open(&input_path)?;
    let mut audio: Option<device::AudioSink> = None;
    let mut pcm = vec![0i16; ((AUDIO_RATE as usize).div_ceil(TICK_HZ as usize) + 1) * 2];

    let tick_duration = Duration::from_nanos(1_000_000_000 / TICK_HZ as u64);
    let mut deadline = Instant::now();
    let mut tick = 0u32;
    let mut render_sum = Duration::ZERO;
    let mut render_max = Duration::ZERO;
    let mut render_count = 0u32;

    loop {
        keyboard.poll()?;
        if keyboard.quit_requested() {
            break;
        }

        guest.frame(keyboard.mask())?;
        {
            let mut scene = host.scene.borrow_mut();
            if !no_audio && host.audio_wanted.get() {
                if audio.is_none() {
                    match device::AudioSink::open(AUDIO_RATE) {
                        Ok(sink) => {
                            log::info!("cardputer: audio {} Hz stereo", AUDIO_RATE);
                            audio = Some(sink);
                        }
                        Err(error) => {
                            log::warn!("cardputer: audio disabled: {error:#}");
                            no_audio = true;
                        }
                    }
                }
                let frames = audio_frames_for_tick(tick, AUDIO_RATE);
                scene.render_audio(&pak, frames, &mut pcm[..frames * 2]);
                if let Some(sink) = audio.as_mut()
                    && let Err(error) = sink.write(&pcm[..frames * 2])
                {
                    log::warn!("cardputer: audio stopped: {error:#}");
                    audio = None;
                    no_audio = true;
                }
            }
            scene.tick();
        }
        tick = tick.wrapping_add(1);

        if tick.is_multiple_of(TICKS_PER_PRESENT) {
            let started = Instant::now();
            let frame = {
                let scene = host.scene.borrow();
                let list = draw::build(&scene, &pak);
                raster::render_at(&list, &pak, &cache, fit.draw_w, fit.draw_h)
            };
            framebuffer.present(&frame.color)?;
            let elapsed = started.elapsed();
            render_sum += elapsed;
            render_max = render_max.max(elapsed);
            render_count += 1;
            if render_count == 60 {
                log::info!(
                    "cardputer: render mean {:.1} ms, max {:.1} ms",
                    render_sum.as_secs_f64() * 1000.0 / render_count as f64,
                    render_max.as_secs_f64() * 1000.0,
                );
                render_sum = Duration::ZERO;
                render_max = Duration::ZERO;
                render_count = 0;
            }
        }

        if max_ticks.is_some_and(|limit| tick >= limit) {
            break;
        }
        deadline += tick_duration;
        let now = Instant::now();
        if now < deadline {
            std::thread::sleep(deadline - now);
        } else if now.duration_since(deadline) > Duration::from_millis(250) {
            log::warn!("cardputer: frame loop fell behind; resetting cadence");
            deadline = now;
        }
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn audio_frames_for_tick(tick: u32, rate: u32) -> usize {
    let tick = tick as u64;
    let rate = rate as u64;
    (((tick + 1) * rate) / 60 - (tick * rate) / 60) as usize
}

#[cfg(not(target_os = "linux"))]
fn main() {
    eprintln!("pocketvoxel-cardputer runs on Linux/aarch64 Cardputer Zero hardware");
}
