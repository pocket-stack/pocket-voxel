use std::fs::{File, OpenOptions, read_to_string};
use std::io::{ErrorKind, Read, Write};
use std::os::unix::fs::{FileExt, OpenOptionsExt};
use std::path::Path;
use std::process::{Child, ChildStdin, Command, Stdio};

use anyhow::{Context, Result, bail};

use pocketvoxel_cardputer::{KeyboardState, ScalePlan};

const EV_KEY: u16 = 1;

pub struct Framebuffer {
    file: File,
    width: usize,
    height: usize,
    stride: usize,
    pixels: Vec<u8>,
    fit: ScalePlan,
    scale: ScalePlan,
}

impl Framebuffer {
    pub fn open(path: &Path, src_w: usize, src_h: usize) -> Result<Self> {
        let canonical = path
            .canonicalize()
            .with_context(|| format!("resolving framebuffer {}", path.display()))?;
        let name = canonical
            .file_name()
            .and_then(|s| s.to_str())
            .context("framebuffer path has no device name")?;
        let sys = Path::new("/sys/class/graphics").join(name);
        let size = read_to_string(sys.join("virtual_size"))
            .with_context(|| format!("reading {}/virtual_size", sys.display()))?;
        let (width, height) = size
            .trim()
            .split_once(',')
            .and_then(|(w, h)| Some((w.parse().ok()?, h.parse().ok()?)))
            .with_context(|| format!("invalid framebuffer size {size:?}"))?;
        let bpp: usize = read_to_string(sys.join("bits_per_pixel"))
            .context("reading framebuffer bit depth")?
            .trim()
            .parse()
            .context("invalid framebuffer bit depth")?;
        if bpp != 16 {
            bail!("Cardputer framebuffer must be RGB565 (16 bpp), got {bpp} bpp");
        }
        let stride = width * 2;
        let fit =
            ScalePlan::fit(src_w, src_h, width, height).context("invalid display geometry")?;
        let scale = ScalePlan::fit(fit.draw_w, fit.draw_h, width, height)
            .context("invalid native render geometry")?;
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .open(&canonical)
            .with_context(|| format!("opening framebuffer {}", canonical.display()))?;
        Ok(Self {
            file,
            width,
            height,
            stride,
            pixels: vec![0; stride * height],
            fit,
            scale,
        })
    }

    pub fn geometry(&self) -> (usize, usize, ScalePlan) {
        (self.width, self.height, self.fit)
    }

    pub fn present(&mut self, abgr: &[u32]) -> Result<()> {
        if !self.scale.write_rgb565(abgr, &mut self.pixels, self.stride) {
            bail!("renderer returned a frame with the wrong geometry");
        }
        let mut written = 0;
        while written < self.pixels.len() {
            let n = self
                .file
                .write_at(&self.pixels[written..], written as u64)
                .context("writing framebuffer")?;
            if n == 0 {
                bail!("short framebuffer write at byte {written}");
            }
            written += n;
        }
        Ok(())
    }
}

#[repr(C)]
#[derive(Clone, Copy)]
struct InputEvent {
    time: libc::timeval,
    kind: u16,
    code: u16,
    value: i32,
}

pub struct Keyboard {
    file: File,
    state: KeyboardState,
}

impl Keyboard {
    pub fn open(path: &Path) -> Result<Self> {
        let file = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NONBLOCK)
            .open(path)
            .with_context(|| format!("opening keyboard {}", path.display()))?;
        Ok(Self {
            file,
            state: KeyboardState::default(),
        })
    }

    pub fn poll(&mut self) -> Result<()> {
        let event_size = std::mem::size_of::<InputEvent>();
        let mut bytes = vec![0u8; event_size * 32];
        loop {
            match self.file.read(&mut bytes) {
                Ok(0) => break,
                Ok(n) => {
                    if n % event_size != 0 {
                        bail!("evdev returned a partial input_event ({n} bytes)");
                    }
                    for chunk in bytes[..n].chunks_exact(event_size) {
                        let event = unsafe {
                            std::ptr::read_unaligned(chunk.as_ptr().cast::<InputEvent>())
                        };
                        if event.kind == EV_KEY {
                            self.state.event(event.code, event.value);
                        }
                    }
                }
                Err(error) if error.kind() == ErrorKind::WouldBlock => break,
                Err(error) => return Err(error).context("reading Cardputer keyboard"),
            }
        }
        Ok(())
    }

    pub fn mask(&self) -> u32 {
        self.state.mask()
    }

    pub fn quit_requested(&self) -> bool {
        self.state.quit_requested()
    }
}

pub struct AudioSink {
    child: Child,
    input: Option<ChildStdin>,
}

impl AudioSink {
    pub fn open(rate: u32) -> Result<Self> {
        let mut child = Command::new("pw-cat")
            .args([
                "--playback",
                "--raw",
                "--format=s16",
                "--channels=2",
                &format!("--rate={rate}"),
                "--latency=100ms",
                "-",
            ])
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .context("starting pw-cat audio output")?;
        let input = child.stdin.take().context("pw-cat did not open stdin")?;
        Ok(Self {
            child,
            input: Some(input),
        })
    }

    pub fn write(&mut self, samples: &[i16]) -> Result<()> {
        let bytes = unsafe {
            std::slice::from_raw_parts(
                samples.as_ptr().cast::<u8>(),
                std::mem::size_of_val(samples),
            )
        };
        self.input
            .as_mut()
            .context("audio stream is closed")?
            .write_all(bytes)
            .context("writing PCM to pw-cat")
    }
}

impl Drop for AudioSink {
    fn drop(&mut self) {
        self.input.take();
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
