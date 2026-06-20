extends Object
## Server-room incident 💥🔥 — a rare comedic emergency: a fiery blast plus a
## lingering fire an agent rushes over to put out. Pure code (additive billboards
## + GPUParticles3D), in the spirit of burst_factory — reliable, no external
## scene/script dependencies.

# A punchy one-shot blast: blinding flash + expanding fireball + shockwave ring
# + ember burst. Self-frees after ~2.5s.
static func boom(host: Node3D, pos: Vector3, fx_scale := 1.0) -> void:
	if not is_instance_valid(host):
		return
	var root := Node3D.new()
	host.add_child(root)
	root.position = pos
	root.scale = Vector3.ONE * fx_scale

	# Blinding orange flash.
	var flash := OmniLight3D.new()
	flash.light_color = Color(1.0, 0.55, 0.18)
	flash.light_energy = 0.0
	flash.omni_range = 10.0
	root.add_child(flash)
	flash.position = Vector3(0, 1.0, 0)
	var ftw := host.create_tween()
	ftw.tween_property(flash, "light_energy", 11.0, 0.05)
	ftw.tween_property(flash, "light_energy", 0.0, 0.6)

	# Expanding fireball billboard.
	var ball := MeshInstance3D.new()
	var qmesh := QuadMesh.new()
	qmesh.size = Vector2(2.2, 2.2)
	ball.mesh = qmesh
	var bmat := StandardMaterial3D.new()
	bmat.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
	bmat.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA
	bmat.blend_mode = BaseMaterial3D.BLEND_MODE_ADD
	bmat.billboard_mode = BaseMaterial3D.BILLBOARD_ENABLED
	bmat.albedo_color = Color(1.0, 0.7, 0.25, 0.95)
	ball.material_override = bmat
	ball.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
	root.add_child(ball)
	ball.position = Vector3(0, 1.1, 0)
	ball.scale = Vector3.ONE * 0.3
	var btw := host.create_tween()
	btw.set_parallel(true)
	btw.tween_property(ball, "scale", Vector3.ONE * 1.9, 0.4).set_trans(Tween.TRANS_QUART).set_ease(Tween.EASE_OUT)
	btw.tween_property(bmat, "albedo_color:a", 0.0, 0.5)

	# Ground shockwave ring.
	var ring := MeshInstance3D.new()
	var tm := TorusMesh.new()
	tm.inner_radius = 0.42
	tm.outer_radius = 0.5
	ring.mesh = tm
	var rmat := StandardMaterial3D.new()
	rmat.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
	rmat.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA
	rmat.blend_mode = BaseMaterial3D.BLEND_MODE_ADD
	rmat.albedo_color = Color(1.0, 0.6, 0.2, 0.9)
	ring.material_override = rmat
	ring.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
	root.add_child(ring)
	ring.position = Vector3(0, 0.06, 0)
	ring.scale = Vector3(0.2, 0.5, 0.2)
	var rtw := host.create_tween()
	rtw.set_parallel(true)
	rtw.tween_property(ring, "scale", Vector3(3.6, 0.5, 3.6), 0.55).set_trans(Tween.TRANS_QUART).set_ease(Tween.EASE_OUT)
	rtw.tween_property(rmat, "albedo_color:a", 0.0, 0.55)

	# Ember + debris burst.
	var sparks := GPUParticles3D.new()
	sparks.amount = 30
	sparks.lifetime = 0.9
	sparks.one_shot = true
	sparks.explosiveness = 1.0
	var sm := ParticleProcessMaterial.new()
	sm.direction = Vector3(0, 1, 0)
	sm.spread = 75.0
	sm.initial_velocity_min = 2.6
	sm.initial_velocity_max = 5.2
	sm.gravity = Vector3(0, -5.0, 0)
	sm.scale_min = 0.5
	sm.scale_max = 1.3
	sm.color = Color(1.0, 0.65, 0.2)
	sparks.process_material = sm
	var quad := QuadMesh.new()
	quad.size = Vector2(0.09, 0.09)
	var qm := StandardMaterial3D.new()
	qm.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
	qm.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA
	qm.blend_mode = BaseMaterial3D.BLEND_MODE_ADD
	qm.billboard_mode = BaseMaterial3D.BILLBOARD_PARTICLES
	qm.vertex_color_use_as_albedo = true
	quad.material = qm
	sparks.draw_pass_1 = quad
	root.add_child(sparks)
	sparks.position = Vector3(0, 0.6, 0)
	sparks.emitting = true

	host.get_tree().create_timer(2.5).timeout.connect(root.queue_free)

# A lingering fire at pos — flickering light + rising flame particles. Returns
# the node; call put_out() (or free it) to extinguish.
static func ignite(host: Node3D, pos: Vector3) -> Node3D:
	if not is_instance_valid(host):
		return null
	var root := Node3D.new()
	host.add_child(root)
	root.position = pos

	var lamp := OmniLight3D.new()
	lamp.light_color = Color(1.0, 0.5, 0.15)
	lamp.light_energy = 3.0
	lamp.omni_range = 5.0
	root.add_child(lamp)
	lamp.position = Vector3(0, 0.8, 0)
	# Flicker forever (the tween loops) until the node is freed.
	var flick := host.create_tween().set_loops()
	flick.tween_property(lamp, "light_energy", 4.6, 0.12)
	flick.tween_property(lamp, "light_energy", 2.4, 0.1)
	flick.tween_property(lamp, "light_energy", 3.8, 0.09)

	var fire := GPUParticles3D.new()
	fire.amount = 44
	fire.lifetime = 0.9
	var fm := ParticleProcessMaterial.new()
	fm.direction = Vector3(0, 1, 0)
	fm.spread = 18.0
	fm.initial_velocity_min = 1.6
	fm.initial_velocity_max = 3.0
	fm.gravity = Vector3(0, 1.2, 0)   # fire rises
	fm.scale_min = 0.6
	fm.scale_max = 1.5
	fm.color = Color(1.0, 0.6, 0.2)
	fm.emission_shape = ParticleProcessMaterial.EMISSION_SHAPE_SPHERE
	fm.emission_sphere_radius = 0.45
	fire.process_material = fm
	var fq := QuadMesh.new()
	fq.size = Vector2(0.34, 0.34)
	var fqm := StandardMaterial3D.new()
	fqm.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
	fqm.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA
	fqm.blend_mode = BaseMaterial3D.BLEND_MODE_ADD
	fqm.billboard_mode = BaseMaterial3D.BILLBOARD_PARTICLES
	fqm.vertex_color_use_as_albedo = true
	fqm.albedo_color = Color(1.0, 0.55, 0.2, 0.85)
	fq.material = fqm
	fire.draw_pass_1 = fq
	root.add_child(fire)
	fire.position = Vector3(0, 0.3, 0)
	fire.emitting = true
	return root

# Stop emitting + let the last particles fade, then free. A puff of smoke caps it.
static func put_out(host: Node3D, fire: Node3D) -> void:
	if not is_instance_valid(fire):
		return
	for c in fire.get_children():
		if c is GPUParticles3D:
			c.emitting = false
	if is_instance_valid(host):
		host.get_tree().create_timer(1.2).timeout.connect(fire.queue_free)
	else:
		fire.queue_free()
