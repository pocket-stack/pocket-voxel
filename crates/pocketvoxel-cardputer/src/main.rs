#[cfg(target_os = "linux")]
mod device;
#[cfg(target_os = "linux")]
mod gles;
#[cfg(target_os = "linux")]
mod surface;

#[cfg(target_os = "linux")]
fn main() -> anyhow::Result<()> {
    use std::path::PathBuf;
    use std::time::{Duration, Instant};

    use anyhow::{Context, bail};
    use pocket_mod::Guest;
    use pocketvoxel_cardputer::{AUDIO_RATE, configure_audio};
    use pocketvoxel_core::draw;
    use pocketvoxel_core::pak::{self, AlignedBlob};
    use pocketvoxel_core::spec::{TICK_HZ, VIEW_H, VIEW_W};
    use pocketvoxel_sim::raster;

    const TICKS_PER_PRESENT: u32 = 2;
    const AUDIO_PREROLL_MS: usize = 200;

    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();

    let mut pak_path: Option<PathBuf> = None;
    let mut bundle_path: Option<PathBuf> = None;
    let mut framebuffer_path = PathBuf::from("/dev/fb_lcd");
    let mut input_path = PathBuf::from("/dev/input/cardputer-zero-internal");
    let mut max_ticks: Option<u32> = None;
    let mut no_audio = false;
    let mut software = false;
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
            "--software" => software = true,
            "--help" | "-h" => {
                println!(
                    "usage: pocketvoxel-cardputer [--pak path] [--bundle path] [--framebuffer path] [--input path] [--frames ticks] [--no-audio] [--software]"
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
    let guest = Guest::new()?;
    let host = surface::mount(&guest, pak.game, pak.audio)?;
    if !configure_audio(&mut host.scene.borrow_mut()) {
        bail!("unsupported audio rate {AUDIO_RATE}");
    }
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
    let cache = software.then(|| raster::AtlasCache::new(&pak));
    let mut gpu = if software {
        log::warn!("cardputer: explicit CPU software rasterizer selected");
        None
    } else {
        Some(gles::Renderer::new(&pak, fit.draw_w, fit.draw_h).context(
            "initializing the required hardware GLES2 renderer (use --software only for diagnostics)",
        )?)
    };
    let mut tick = 0u32;
    let mut pending_audio_frames = 0usize;
    if let Some(renderer) = gpu.as_mut() {
        // Prime both shader paths, the VC4 binner and the map's first draw
        // before PipeWire starts. A cold GPU frame may compile shaders and
        // allocate CMA, but it must never starve an already-playing stream.
        let warm_started = Instant::now();
        guest.frame(0)?;
        host.scene.borrow_mut().tick();
        tick = 1;
        pending_audio_frames = audio_frames_for_tick(0, AUDIO_RATE);
        let frame = {
            let scene = host.scene.borrow();
            let list = draw::build(&scene, &pak);
            renderer.render(&list, &pak)?
        };
        framebuffer.present(&frame)?;
        log::info!(
            "cardputer: GPU warm frame {:.1} ms before audio start",
            warm_started.elapsed().as_secs_f64() * 1000.0,
        );
    }
    let mut keyboard = device::Keyboard::open(&input_path)?;
    let mut audio: Option<device::AudioSink> = None;
    let per_tick_capacity = (AUDIO_RATE as usize).div_ceil(TICK_HZ as usize) + 1;
    let preroll_capacity = AUDIO_RATE as usize * AUDIO_PREROLL_MS / 1000;
    let mut pcm = vec![0i16; (preroll_capacity + per_tick_capacity * 2) * 2];
    let mut audio_prerolled = false;

    let tick_duration = Duration::from_nanos(1_000_000_000 / TICK_HZ as u64);
    let mut deadline = Instant::now();
    let mut render_sum = Duration::ZERO;
    let mut render_max = Duration::ZERO;
    let mut raster_sum = Duration::ZERO;
    let mut present_sum = Duration::ZERO;
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
                let preroll = if audio_prerolled {
                    0
                } else {
                    audio_prerolled = true;
                    preroll_capacity
                };
                let frames =
                    audio_frames_for_tick(tick, AUDIO_RATE) + pending_audio_frames + preroll;
                pending_audio_frames = 0;
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

        let render_lateness = Instant::now().saturating_duration_since(deadline);
        if tick.is_multiple_of(TICKS_PER_PRESENT) && render_lateness <= tick_duration {
            let started = Instant::now();
            let backend_started = Instant::now();
            let frame = if let Some(renderer) = gpu.as_mut() {
                let scene = host.scene.borrow();
                let list = draw::build(&scene, &pak);
                renderer.render(&list, &pak)?
            } else {
                let scene = host.scene.borrow();
                let list = draw::build(&scene, &pak);
                raster::render_at(
                    &list,
                    &pak,
                    cache.as_ref().context("software atlas cache is missing")?,
                    fit.draw_w,
                    fit.draw_h,
                )
                .color
            };
            raster_sum += backend_started.elapsed();
            let present_started = Instant::now();
            framebuffer.present(&frame)?;
            present_sum += present_started.elapsed();
            let elapsed = started.elapsed();
            render_sum += elapsed;
            render_max = render_max.max(elapsed);
            render_count += 1;
            if render_count == 60 {
                log::info!(
                    "cardputer: frame mean {:.1} ms (render/readback {:.1} + present {:.1}), max {:.1} ms",
                    render_sum.as_secs_f64() * 1000.0 / render_count as f64,
                    raster_sum.as_secs_f64() * 1000.0 / render_count as f64,
                    present_sum.as_secs_f64() * 1000.0 / render_count as f64,
                    render_max.as_secs_f64() * 1000.0,
                );
                render_sum = Duration::ZERO;
                render_max = Duration::ZERO;
                raster_sum = Duration::ZERO;
                present_sum = Duration::ZERO;
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
