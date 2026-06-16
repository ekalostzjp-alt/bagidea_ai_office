extends Sprite3D
## Tiny flapping bird crossing the sky — ambient gimmick, spawned in small
## flocks by world_builder and freed when its flight tween ends.

const WING_UP: Array[String] = [
	"b.........b",
	".bb.....bb.",
	"...b.b.b...",
	"....bbb....",
]
const WING_DN: Array[String] = [
	"...........",
	"....bbb....",
	"..bb.b.bb..",
	".b.......b.",
]

var _tex_up: ImageTexture
var _tex_dn: ImageTexture
var _t := 0.0
var _flap := 0.0

func _ready() -> void:
	layers = 2  # sky life never lands on the static map render
	_tex_up = _bake(WING_UP)
	_tex_dn = _bake(WING_DN)
	texture = _tex_up
	pixel_size = 0.05
	billboard = BaseMaterial3D.BILLBOARD_ENABLED
	shaded = false
	alpha_cut = SpriteBase3D.ALPHA_CUT_DISCARD
	texture_filter = BaseMaterial3D.TEXTURE_FILTER_NEAREST
	cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
	_t = randf() * TAU
	_flap = randf() * 0.12

func _bake(art: Array[String]) -> ImageTexture:
	var w: int = art[0].length()
	var h: int = art.size()
	var img := Image.create(w, h, false, Image.FORMAT_RGBA8)
	for y in h:
		for x in w:
			if art[y][x] == "b":
				img.set_pixel(x, y, Color(0.08, 0.09, 0.13))
	return ImageTexture.create_from_image(img)

func _process(delta: float) -> void:
	_flap += delta
	if _flap >= 0.14:
		_flap = 0.0
		texture = _tex_dn if texture == _tex_up else _tex_up
	_t += delta * 2.0
	offset.y = sin(_t) * 1.6  # gentle ride on the air
