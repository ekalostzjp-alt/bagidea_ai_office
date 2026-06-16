extends SceneTree
## Dev probe: prints the real AABB of asset models (glb via GLTFDocument,
## fbx via FBXDocument) so placement math is measured, not guessed. Run:
##   godot --headless --path godot --script res://scripts/probe.gd

const MODELS := [
	"res://assets/env/Mounting_1.fbx", "res://assets/env/Mounting_2.fbx",
	"res://assets/env/Mounting_3.fbx", "res://assets/env/Tree_1.fbx",
	"res://assets/env/Tree_2.fbx", "res://assets/env/Tree_3.fbx",
	"res://assets/env/Rock_1.fbx", "res://assets/env/Bush_1.fbx",
	"res://assets/env/Grass_1.fbx", "res://assets/env/Terrain_1.fbx",
	"res://assets/env/Plant_1.fbx", "res://assets/env/Log_1.fbx",
]

func _init() -> void:
	for path in MODELS:
		var scene: Node = null
		var abs := ProjectSettings.globalize_path(path)
		if path.ends_with(".fbx"):
			var doc := FBXDocument.new()
			var state := FBXState.new()
			if doc.append_from_file(abs, state) == OK:
				scene = doc.generate_scene(state)
		else:
			var doc := GLTFDocument.new()
			var state := GLTFState.new()
			if doc.append_from_file(abs, state) == OK:
				scene = doc.generate_scene(state)
		if scene == null:
			print(path.get_file(), "  LOAD FAILED")
			continue
		var aabb := _merge_aabb(scene, Transform3D.IDENTITY)
		print("%s  size=%v  origin=%v" % [path.get_file(), aabb.size, aabb.position])
		scene.free()
	quit()

func _merge_aabb(node: Node, xf: Transform3D) -> AABB:
	var result := AABB()
	var first := true
	var stack: Array = [[node, xf]]
	while stack.size() > 0:
		var item: Array = stack.pop_back()
		var n: Node = item[0]
		var t: Transform3D = item[1]
		if n is Node3D:
			t = t * (n as Node3D).transform
		if n is MeshInstance3D:
			var ab: AABB = t * (n as MeshInstance3D).get_aabb()
			if first:
				result = ab
				first = false
			else:
				result = result.merge(ab)
		for c in n.get_children():
			stack.append([c, t])
	return result
