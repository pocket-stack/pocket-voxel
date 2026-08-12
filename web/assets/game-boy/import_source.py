"""Create the redistributable, de-branded source GLB from the Sketchfab .blend.

Run with Blender, passing the downloaded source file after ``--``::

    blender -b --python import_source.py -- "/path/to/Skectfab gameboy.blend"

The upstream download is not committed because Sketchfab requires an
authenticated download.  The generated GLB contains the attributed geometry,
but no upstream images, product decals, sample backdrop, camera, or lights.
"""

from pathlib import Path
from hashlib import sha256
import sys

import bpy


HERE = Path(__file__).resolve().parent
OUTPUT = HERE / "source" / "lets-do-3d-gameboy-dmg-01.glb"
EXPECTED_SOURCE_SHA256 = "9658ca66dc7f87d893b7acad9b5d2a4070a14edf9ba7ff24969cda2ba75bcfef"


def rgba(hex_color: str) -> tuple[float, float, float, float]:
    value = hex_color.removeprefix("#")
    return tuple(int(value[index:index + 2], 16) / 255 for index in (0, 2, 4)) + (1.0,)


def source_path() -> Path:
    try:
        separator = sys.argv.index("--")
        value = sys.argv[separator + 1]
    except (ValueError, IndexError) as error:
        raise SystemExit("pass the downloaded Sketchfab .blend after --") from error
    path = Path(value).expanduser().resolve()
    if not path.is_file():
        raise SystemExit(f"source .blend does not exist: {path}")
    digest = sha256(path.read_bytes()).hexdigest()
    if digest != EXPECTED_SOURCE_SHA256:
        raise SystemExit(
            f"source .blend SHA-256 mismatch: got {digest}, need {EXPECTED_SOURCE_SHA256}"
        )
    return path


def set_principled(material: bpy.types.Material, color: str, roughness: float, metallic: float = 0.0) -> None:
    material.use_nodes = True
    nodes = material.node_tree.nodes
    nodes.clear()
    shader = nodes.new("ShaderNodeBsdfPrincipled")
    output = nodes.new("ShaderNodeOutputMaterial")
    shader.inputs["Base Color"].default_value = rgba(color)
    shader.inputs["Roughness"].default_value = roughness
    shader.inputs["Metallic"].default_value = metallic
    material.node_tree.links.new(shader.outputs["BSDF"], output.inputs["Surface"])
    material.diffuse_color = rgba(color)


bpy.ops.wm.open_mainfile(filepath=str(source_path()))

# Only these three meshes belong to the handheld.  The remaining objects are
# cameras, lights, a studio backdrop, branded decal planes, or texture-only
# labels.  In particular, all objects using Decal_01 are removed here rather
# than hidden so the exported asset cannot retain the Nintendo wordmark.
keep = {
    "Cube": "Cartridge",
    "Cube.001": "Device",
    "Plane.005": "ScreenAccentStripes",
}
for obj in list(bpy.data.objects):
    if obj.type != "MESH" or obj.name not in keep:
        bpy.data.objects.remove(obj, do_unlink=True)
        continue
    obj.name = keep[obj.name]
    obj.data.name = f"{obj.name}Mesh"

# Rebuild every retained material from constants.  This deliberately drops the
# cartridge photograph, boot-screen image, decal atlas, and normal-map images;
# several of those contain Nintendo marks even when their mesh is not visible
# from the default camera.
palette = {
    "Base": ("#cec8ba", 0.68, 0.0),
    "Pink_Buttons": ("#9d1f49", 0.34, 0.0),
    "D-Pad": ("#181d22", 0.42, 0.0),
    "Start-Select_Button": ("#4f414d", 0.58, 0.0),
    "Front_Panel": ("#252b35", 0.31, 0.0),
    "Red_Light": ("#ff315b", 0.28, 0.0),
    "Metal": ("#aeb9c0", 0.30, 0.72),
    "Power_Switch": ("#31363c", 0.52, 0.0),
    "Screen": ("#7f9369", 0.48, 0.0),
    "Screen_Edge": ("#53604e", 0.52, 0.0),
    "Cart": ("#6d6a75", 0.62, 0.0),
    "Sticker": ("#263b48", 0.55, 0.0),
    "NormalMap": ("#5a5862", 0.58, 0.0),
    "Blue_Line": ("#3d4f96", 0.42, 0.0),
    "Red_Line": ("#a52d56", 0.42, 0.0),
}
for name, (color, roughness, metallic) in palette.items():
    material = bpy.data.materials.get(name)
    if material is not None:
        set_principled(material, color, roughness, metallic)

# Cube.002 is the original glass overlay.  It is intentionally absent from the
# keep set: an opaque export can cover the live framebuffer, while alpha glass
# adds another draw pass without improving the small web presentation.
for image in list(bpy.data.images):
    bpy.data.images.remove(image, do_unlink=True)

# Blender add-ons may leave scene/object custom properties in the downloaded
# file. They are unrelated to the model and would otherwise be copied into the
# glTF ``extras`` objects.
for data_block in (
    list(bpy.data.scenes)
    + list(bpy.data.objects)
    + list(bpy.data.meshes)
    + list(bpy.data.materials)
):
    for key in list(data_block.keys()):
        del data_block[key]

for _ in range(4):
    if bpy.ops.outliner.orphans_purge(do_recursive=True) == {"CANCELLED"}:
        break

OUTPUT.parent.mkdir(parents=True, exist_ok=True)
bpy.ops.object.select_all(action="DESELECT")
for obj in bpy.context.scene.objects:
    if obj.type == "MESH":
        obj.select_set(True)
bpy.context.view_layer.objects.active = bpy.data.objects.get("Device")
bpy.ops.export_scene.gltf(
    filepath=str(OUTPUT),
    export_format="GLB",
    use_selection=True,
    export_extras=True,
    export_cameras=False,
    export_lights=False,
    export_materials="EXPORT",
    export_yup=True,
)
print(f"wrote de-branded source {OUTPUT}")
