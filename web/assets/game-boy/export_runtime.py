"""Build the Pocket Stage Game Boy GLB from the de-branded source model."""

from pathlib import Path

import bpy


HERE = Path(__file__).resolve().parent
SOURCE = HERE / "source" / "lets-do-3d-gameboy-dmg-01.glb"
OUTPUT = HERE / "gameboy-stage.glb"


bpy.ops.object.select_all(action="SELECT")
bpy.ops.object.delete(use_global=False)
bpy.ops.import_scene.gltf(filepath=str(SOURCE))

device = bpy.data.objects.get("Device")
if device is None or device.type != "MESH":
    raise RuntimeError("source GLB is missing the expected Device mesh")

# Fill the source's 10:9 LCD with the central 160:144 view inside Pocket
# Voxel's 480x272 framebuffer. The core already scales the GB UI to 272 pixels
# high and centers its 302.22-pixel width, so the 5/27..22/27 UV crop is exact:
# the UI fills the glass without stretching and the 3D world is center-cropped.
screen_material_index = next(
    (index for index, material in enumerate(device.data.materials) if material and material.name == "Screen"),
    None,
)
if screen_material_index is None:
    raise RuntimeError("source GLB is missing the Screen material")
screen_vertices = [
    device.matrix_world @ device.data.vertices[vertex_index].co
    for polygon in device.data.polygons
    if polygon.material_index == screen_material_index
    for vertex_index in polygon.vertices
]
if not screen_vertices:
    raise RuntimeError("source GLB has no Screen primitive")

mesh = bpy.data.meshes.new("PocketVoxelScreenMesh")
screen = bpy.data.objects.new("PocketVoxelScreen", mesh)
bpy.context.collection.objects.link(screen)

center_y = (min(vertex.y for vertex in screen_vertices) + max(vertex.y for vertex in screen_vertices)) / 2
center_z = (min(vertex.z for vertex in screen_vertices) + max(vertex.z for vertex in screen_vertices)) / 2
half_width = (max(vertex.y for vertex in screen_vertices) - min(vertex.y for vertex in screen_vertices)) / 2
half_height = half_width * 9.0 / 10.0
front_x = max(vertex.x for vertex in screen_vertices) + 0.001
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
# Per-loop UVs follow the vertex order above. glTF carries the exact central
# crop for Pocket Stage's CanvasTexture.
crop_left = 5.0 / 27.0
crop_right = 22.0 / 27.0
uvs = (
    (crop_left, 0.0),
    (crop_right, 0.0),
    (crop_right, 1.0),
    (crop_left, 1.0),
)
for polygon in mesh.polygons:
    for loop_index in polygon.loop_indices:
        vertex_index = mesh.loops[loop_index].vertex_index
        uv_layer.data[loop_index].uv = uvs[vertex_index]

screen_material = bpy.data.materials.new("P3D_dynamic_screen__gameboy_lcd")
screen_material.diffuse_color = (1.0, 1.0, 1.0, 1.0)
screen_material["pocket3d_role"] = "dynamic_screen"
mesh.materials.append(screen_material)

# Keep the screen role above, but do not leak unrelated Blender add-on state
# from the local startup scene into the exported glTF scene extras.
for key in list(bpy.context.scene.keys()):
    del bpy.context.scene[key]

bpy.ops.object.select_all(action="DESELECT")
for obj in bpy.context.scene.objects:
    if obj.type == "MESH":
        obj.select_set(True)
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
