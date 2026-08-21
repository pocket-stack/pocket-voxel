use std::cell::{Cell, RefCell};
use std::rc::Rc;
use std::sync::Arc;

use anyhow::Result;
use pocket_mod::Guest;
use pocket_mod::qjs::{ArrayBuffer, Ctx, Function, Value};
use pocketvoxel_core::scene::Scene;
use pocketvoxel_core::spec::op;

thread_local! {
    /// The guest calls audiodata once during boot. Keeping the immutable bytes
    /// thread-local gives the named higher-ranked callback the same JS lifetime
    /// as its `Ctx` without making the scene global.
    static AUDIO_BYTES: RefCell<Arc<[u8]>> = RefCell::new(Arc::from([]));
}

pub struct VoxelSurface {
    pub scene: Rc<RefCell<Scene>>,
    pub audio_wanted: Rc<Cell<bool>>,
}

fn apply(scene: &Rc<RefCell<Scene>>, code: u32, args: &[i32], text: Option<&str>) {
    scene.borrow_mut().op(code, args, text);
}

fn js_audiodata<'js>(ctx: Ctx<'js>) -> pocket_mod::qjs::Result<Value<'js>> {
    AUDIO_BYTES.with(|slot| {
        let audio = slot.borrow();
        if audio.is_empty() {
            Ok(Value::new_undefined(ctx))
        } else {
            ArrayBuffer::new_copy(ctx, audio.as_ref()).map(ArrayBuffer::into_value)
        }
    })
}

pub fn mount(guest: &Guest, game: &[u8], audio: &[u8]) -> Result<VoxelSurface> {
    let scene = Rc::new(RefCell::new(Scene::new()));
    let audio_wanted = Rc::new(Cell::new(false));
    let game = String::from_utf8(game.to_vec())?;
    let audio: Arc<[u8]> = Arc::from(audio);
    AUDIO_BYTES.with(|slot| *slot.borrow_mut() = audio);

    let mount_scene = scene.clone();
    let mount_audio_wanted = audio_wanted.clone();
    guest.mount("voxel", move |ctx, ns| {
        macro_rules! op0 {
            ($name:literal, $code:expr) => {{
                let scene = mount_scene.clone();
                ns.set(
                    $name,
                    Function::new(ctx.clone(), move || apply(&scene, $code, &[], None))?,
                )?;
            }};
        }
        macro_rules! opn {
            ($name:literal, $code:expr, $($arg:ident),+ $(,)?) => {{
                let scene = mount_scene.clone();
                ns.set(
                    $name,
                    Function::new(ctx.clone(), move |$($arg: i32),+| {
                        apply(&scene, $code, &[$($arg),+], None)
                    })?,
                )?;
            }};
        }
        macro_rules! audio_op {
            ($name:literal, $code:expr $(, $arg:ident)*) => {{
                let scene = mount_scene.clone();
                let wanted = mount_audio_wanted.clone();
                ns.set(
                    $name,
                    Function::new(ctx.clone(), move |$($arg: i32),*| {
                        wanted.set(true);
                        apply(&scene, $code, &[$($arg),*], None)
                    })?,
                )?;
            }};
        }

        let game = game.clone();
        ns.set(
            "gamedata",
            Function::new(ctx.clone(), move || game.clone())?,
        )?;
        ns.set("audiodata", Function::new(ctx.clone(), js_audiodata)?)?;
        ns.set("stats", Function::new(ctx.clone(), || ())?)?;
        ns.set("remoteOpen", Function::new(ctx.clone(), || false)?)?;
        ns.set("remoteTick", Function::new(ctx.clone(), || -1)?)?;
        ns.set("remoteClose", Function::new(ctx.clone(), || ())?)?;

        op0!("reset", op::RESET);
        opn!("mapShow", op::MAP_SHOW, slot, map_id, ox, oy);
        opn!("mapHide", op::MAP_HIDE, slot);
        opn!("cam", op::CAM, x, y);
        opn!("pitch", op::PITCH, rung);
        opn!("tint", op::TINT, abgr);
        opn!("sky", op::SKY, on);
        opn!("stamp", op::STAMP, map_id, cx, cy, on);
        opn!("palette", op::PALETTE, index);
        opn!("ent", op::ENT, slot, sheet, frame, x, y, lift, flags);
        opn!("entHide", op::ENT_HIDE, slot);
        opn!("emote", op::EMOTE, slot, kind);
        opn!("uiTile", op::UI_TILE, x, y, tile);
        opn!("uiFill", op::UI_FILL, x, y, w, h, tile);
        {
            let scene = mount_scene.clone();
            ns.set(
                "uiText",
                Function::new(ctx.clone(), move |x: i32, y: i32, text: String| {
                    apply(&scene, op::UI_TEXT, &[x, y], Some(&text))
                })?,
            )?;
        }
        opn!("uiReveal", op::UI_REVEAL, count);
        op0!("uiClear", op::UI_CLEAR);
        opn!("uiRect", op::UI_RECT, x, y, w, h, abgr);
        {
            let scene = mount_scene.clone();
            ns.set(
                "uiLabel",
                Function::new(
                    ctx.clone(),
                    move |x: i32, y: i32, scale: i32, abgr: i32, text: String| {
                        apply(&scene, op::UI_LABEL, &[x, y, scale, abgr], Some(&text))
                    },
                )?,
            )?;
        }
        op0!("uiOverlayClear", op::UI_OVERLAY_CLEAR);
        opn!("remotePlane", op::REMOTE_PLANE, x, y, w, h);
        opn!("arena", op::ARENA, map_id, x, y, shape, rig);
        opn!("card", op::CARD, side, pic, x, y);
        opn!("cardHide", op::CARD_HIDE, side);
        opn!("battleCam", op::BATTLE_CAM, orbit, pitch, zoom);
        op0!("arenaEnd", op::ARENA_END);

        audio_op!("music", op::MUSIC, bank, addr, engine, flags);
        audio_op!("musicStop", op::MUSIC_STOP);
        audio_op!("musicFade", op::MUSIC_FADE, ticks);
        audio_op!("sfx", op::SFX, bank, addr, engine, pitch, tempo, flags);
        audio_op!("cry", op::CRY, bank, addr, engine, pitch, length);
        audio_op!("audioWaves", op::AUDIO_WAVES, engine, bank, addr);
        audio_op!("audioDrum", op::AUDIO_DRUM, engine, drum, bank, addr);
        Ok(())
    })?;

    Ok(VoxelSurface {
        scene,
        audio_wanted,
    })
}
