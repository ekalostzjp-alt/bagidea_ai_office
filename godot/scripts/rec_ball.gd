extends CSGSphere3D
## The recreation football ⚽ — gets "kicked" around its corner of the rec
## room in lazy arcs forever. Ambient life, zero events.

## Kick HALF-extents around _home (the rec room cell). _home is set by
## world_builder and re-set on room swap, so the ball follows its room.
const HX := 2.4
const HZ := 1.8
var _home := Vector2(-10.5, 8.0)
const KICK_SPEED := 4.5

var _rolling := 0.0

func _ready() -> void:
	layers = 2  # moving prop — keep it off the static map render
	# No phantom kicks: the ball rests until someone actually plays with it.

## Re-centre the ball on a new room cell (called on room swap).
func set_home(c: Vector3) -> void:
	_home = Vector2(c.x, c.z)
	position = Vector3(c.x, position.y, c.z)

func _process(delta: float) -> void:
	# The texture sells the kick: spin while airborne, settle when resting.
	if _rolling > 0.0:
		_rolling -= delta
		rotate_x(-delta * 7.0)
		rotate_z(delta * 2.4)

## One immediate kick — idle agents playing football call this.
func kick_now() -> void:
	Sfx.play("pop")
	_do_kick()

func _do_kick() -> void:
	var target := Vector3(
		_home.x + randf_range(-HX, HX),
		position.y,
		_home.y + randf_range(-HZ, HZ))
	var dur: float = maxf(position.distance_to(target) / KICK_SPEED, 0.25)
	_rolling = dur
	var tw := create_tween()
	tw.set_parallel(true)
	tw.tween_property(self, "position:x", target.x, dur)
	tw.tween_property(self, "position:z", target.z, dur)
	# arc: up then down
	tw.set_parallel(false)
	var base_y := position.y
	tw.tween_property(self, "position:y", base_y, 0.0)
	var arc := create_tween()
	arc.tween_property(self, "position:y", base_y + 0.7, dur * 0.5) \
		.set_trans(Tween.TRANS_QUAD).set_ease(Tween.EASE_OUT)
	arc.tween_property(self, "position:y", base_y, dur * 0.5) \
		.set_trans(Tween.TRANS_QUAD).set_ease(Tween.EASE_IN)
	await tw.finished
