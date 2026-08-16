"""Render a deterministic Blender preview of the exported stage model."""

from pathlib import Path
import sys

import bpy
from mathutils import Vector


HERE = Path(__file__).resolve().parent


def arguments() -> tuple[Path, Path]:
    values = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    model = Path(values[0]).resolve() if values else HERE / "gameboy-stage.glb"
    output = Path(values[1]).resolve() if len(values) > 1 else Path("/tmp/pocket-voxel-gameboy.png")
    return model, output


MODEL, OUTPUT = arguments()
bpy.ops.object.select_all(action="SELECT")
bpy.ops.object.delete(use_global=False)
bpy.ops.import_scene.gltf(filepath=str(MODEL))

meshes = [obj for obj in bpy.context.scene.objects if obj.type == "MESH"]
points = [obj.matrix_world @ vertex.co for obj in meshes for vertex in obj.data.vertices]
minimum = Vector(tuple(min(point[axis] for point in points) for axis in range(3)))
maximum = Vector(tuple(max(point[axis] for point in points) for axis in range(3)))
center = (minimum + maximum) / 2

screen = bpy.data.materials.get("P3D_dynamic_screen__gameboy_lcd")
if screen and screen.use_nodes:
    shader = screen.node_tree.nodes.get("Principled BSDF")
    if shader:
        shader.inputs["Base Color"].default_value = (0.32, 0.62, 0.48, 1.0)
        shader.inputs["Emission Color"].default_value = (0.05, 0.22, 0.13, 1.0)
        shader.inputs["Emission Strength"].default_value = 0.45

floor_material = bpy.data.materials.new("PreviewFloor")
floor_material.diffuse_color = (0.012, 0.028, 0.048, 1.0)
bpy.ops.mesh.primitive_plane_add(size=30, location=(center.x, center.y, minimum.z - 0.025))
bpy.context.object.data.materials.append(floor_material)

camera_data = bpy.data.cameras.new("PreviewCamera")
camera = bpy.data.objects.new("PreviewCamera", camera_data)
bpy.context.collection.objects.link(camera)
camera.location = center + Vector((7.2, -5.4, 3.6))
camera.rotation_euler = (center - camera.location).to_track_quat("-Z", "Y").to_euler()
camera_data.lens = 62
bpy.context.scene.camera = camera


def area_light(name: str, location: tuple[float, float, float], energy: float, color: tuple[float, float, float], size: float) -> None:
    data = bpy.data.lights.new(name, "AREA")
    data.energy = energy
    data.color = color
    data.shape = "DISK"
    data.size = size
    light = bpy.data.objects.new(name, data)
    bpy.context.collection.objects.link(light)
    light.location = center + Vector(location)
    light.rotation_euler = (center - light.location).to_track_quat("-Z", "Y").to_euler()


area_light("Key", (5.0, -3.6, 6.5), 900, (0.88, 0.95, 1.0), 4.0)
area_light("Fill", (3.0, 4.5, 3.5), 650, (0.48, 1.0, 0.78), 3.5)
area_light("Rim", (-3.0, -1.0, 5.0), 800, (1.0, 0.32, 0.48), 3.0)

world = bpy.context.scene.world or bpy.data.worlds.new("PreviewWorld")
bpy.context.scene.world = world
world.use_nodes = True
world.node_tree.nodes["Background"].inputs["Color"].default_value = (0.004, 0.012, 0.024, 1.0)
world.node_tree.nodes["Background"].inputs["Strength"].default_value = 0.32

scene = bpy.context.scene
scene.render.engine = "BLENDER_EEVEE"
scene.render.resolution_x = 900
scene.render.resolution_y = 900
scene.render.resolution_percentage = 100
scene.render.image_settings.file_format = "PNG"
scene.render.filepath = str(OUTPUT)
scene.render.film_transparent = False
scene.render.image_settings.color_mode = "RGBA"
scene.view_settings.look = "AgX - Medium High Contrast"
OUTPUT.parent.mkdir(parents=True, exist_ok=True)
bpy.ops.render.render(write_still=True)
print(f"wrote preview {OUTPUT}")
