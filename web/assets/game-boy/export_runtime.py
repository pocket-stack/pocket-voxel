"""Build the compact Pocket Stage Game Boy GLB from the attributed source model."""

from pathlib import Path

import bpy


HERE = Path(__file__).resolve().parent
SOURCE = HERE / "source" / "jason-toff-gameboy.glb"
OUTPUT = HERE / "gameboy-stage.glb"


def rgba(hex_color: str) -> tuple[float, float, float, float]:
    value = hex_color.removeprefix("#")
    return tuple(int(value[index:index + 2], 16) / 255 for index in (0, 2, 4)) + (1.0,)


bpy.ops.object.select_all(action="SELECT")
bpy.ops.object.delete(use_global=False)
bpy.ops.import_scene.gltf(filepath=str(SOURCE))

device = bpy.data.objects.get("Node")
if device is None or device.type != "MESH":
    raise RuntimeError("source GLB is missing the expected Node mesh")

for obj in list(bpy.context.scene.objects):
    if obj is not device:
        bpy.data.objects.remove(obj, do_unlink=True)

# Keep the low-poly silhouette, while moving its flat source palette onto the
# same navy / steel / mint / rose family as the PocketJS landing page.
palette = {
    "mat21": "#c7d5dd",
    "mat22": "#748995",
    "mat15": "#aabcc6",
    "mat23": "#13212b",
    "mat9": "#91ad94",
    "mat16": "#334b5a",
    "mat8": "#ff5577",
    "mat17": "#182832",
}
for material in device.data.materials:
    color = palette.get(material.name)
    if not color:
        continue
    material.diffuse_color = rgba(color)
    material.use_nodes = True
    shader = material.node_tree.nodes.get("Principled BSDF")
    if shader:
        shader.inputs["Base Color"].default_value = rgba(color)
        shader.inputs["Roughness"].default_value = 0.72
        shader.inputs["Metallic"].default_value = 0.0

# The source LCD has no UV coordinates. Add a 30:17 live picture plane inside
# its 10:9 green glass. The remaining green above and below is intentional
# letterboxing, so Pocket Voxel's 480x272 framebuffer is never stretched.
mesh = bpy.data.meshes.new("PocketVoxelScreenMesh")
screen = bpy.data.objects.new("PocketVoxelScreen", mesh)
bpy.context.collection.objects.link(screen)

center_y = 0.060194
center_z = 0.255738
half_width = 0.25
half_height = half_width * 17.0 / 30.0
front_x = 0.0785
mesh.from_pydata(
    [
        (front_x, center_y - half_width, center_z - half_height),
        (front_x, center_y + half_width, center_z - half_height),
        (front_x, center_y + half_width, center_z + half_height),
        (front_x, center_y - half_width, center_z + half_height),
    ],
    [],
    [(0, 1, 2, 3)],
)
mesh.update()

uv_layer = mesh.uv_layers.new(name="UVMap")
# Per-loop UVs follow the vertex order above. glTF then carries a normalized,
# full-span texture coordinate set for Pocket Stage's CanvasTexture.
uvs = ((0.0, 0.0), (1.0, 0.0), (1.0, 1.0), (0.0, 1.0))
for polygon in mesh.polygons:
    for loop_index in polygon.loop_indices:
        vertex_index = mesh.loops[loop_index].vertex_index
        uv_layer.data[loop_index].uv = uvs[vertex_index]

screen_material = bpy.data.materials.new("P3D_dynamic_screen__gameboy_lcd")
screen_material.diffuse_color = (1.0, 1.0, 1.0, 1.0)
screen_material["pocket3d_role"] = "dynamic_screen"
mesh.materials.append(screen_material)

bpy.ops.object.select_all(action="DESELECT")
device.select_set(True)
screen.select_set(True)
bpy.context.view_layer.objects.active = device
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
print(f"wrote {OUTPUT}")
