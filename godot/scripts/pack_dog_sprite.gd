extends Sprite3D
## The lawn dog 🐕 — "Pet Dogs Pack" Golden Retriever (gitignored asset).
## Lives OUTSIDE on the south lawn so the office stays tidy; wanders, sits,
## naps, barks at nothing in particular. Pure ambient life.

const DIR := "res://assets/characters/dogs/Dog-1-Golden-Retriever/"
## South lawn, in front of the entrance — never inside the building.
const ROAM := Rect2(-7.0, 15.0, 19.0, 4.5)
const SPEED := 1.0
const RUN_SPEED := 2.4

static func has_assets() -> bool:
	return FileAccess.file_exists(ProjectSettings.globalize_path(DIR + "Golden-Retriever-walk.png"))

var _anims := {}
var _anim := ""
var _frame_t := 0.0
var _tween: Tween
var _moving := false

func _ready() -> void:
	layers = 2
	for spec in [["idle", "Golden-Retriever-idle", 10], ["walk", "Golden-Retriever-walk", 8],
			["run", "Golden-Retriever-run", 8], ["sit", "Golden-Retriever-sitting", 1],
			["sleep", "Golden-Retriever-sleeping", 1], ["bark", "Golden-Retriever-bark", 8]]:
		var path := ProjectSettings.globalize_path(DIR + str(spec[1]) + ".png")
		if FileAccess.file_exists(path):
			var img := Image.load_from_file(path)
			if img:
				_anims[spec[0]] = {"tex": ImageTexture.create_from_image(img),
					"frames": maxi(int(img.get_width() / 100.0), 1)}
	pixel_size = 0.014
	billboard = BaseMaterial3D.BILLBOARD_ENABLED
	shaded = true
	alpha_cut = SpriteBase3D.ALPHA_CUT_DISCARD
	texture_filter = BaseMaterial3D.TEXTURE_FILTER_NEAREST
	offset.y = 34.0  # paws on the node's floor line
	_play("idle")
	_life_loop()

func _play(p_name: String) -> void:
	if _anim == p_name or not _anims.has(p_name):
		return
	_anim = p_name
	var a: Dictionary = _anims[p_name]
	texture = a.tex
	hframes = a.frames
	frame = 0

func _life_loop() -> void:
	while is_inside_tree():
		await get_tree().create_timer(randf_range(3.0, 8.0)).timeout
		if not is_inside_tree():
			return
		var roll := randf()
		if roll < 0.45:
			# Stroll somewhere on the lawn.
			var target := Vector3(
				randf_range(ROAM.position.x, ROAM.position.x + ROAM.size.x),
				position.y,
				randf_range(ROAM.position.y, ROAM.position.y + ROAM.size.y))
			var run := randf() < 0.25
			flip_h = target.x < position.x  # art faces right
			_play("run" if run else "walk")
			_moving = true
			if _tween:
				_tween.kill()
			_tween = create_tween()
			_tween.tween_property(self, "position", target,
				position.distance_to(target) / (RUN_SPEED if run else SPEED))
			await _tween.finished
			_moving = false
			_play("idle")
		elif roll < 0.65:
			_play("sit")
			await get_tree().create_timer(randf_range(4.0, 9.0)).timeout
			_play("idle")
		elif roll < 0.8:
			_play("sleep")
			await get_tree().create_timer(randf_range(8.0, 16.0)).timeout
			_play("idle")
		else:
			_play("bark")
			Sfx.play("blip2")
			await get_tree().create_timer(1.2).timeout
			_play("idle")

func _process(delta: float) -> void:
	if not _anims.has(_anim):
		return
	_frame_t += delta
	var fps := 10.0 if _moving else 6.0
	if _frame_t >= 1.0 / fps and hframes > 1:
		_frame_t = 0.0
		frame = (frame + 1) % hframes