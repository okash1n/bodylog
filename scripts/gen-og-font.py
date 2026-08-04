# OGP画像用ビットマップフォント（src/og-font.ts）の生成スクリプト。
# 必要なグリフだけをシステムフォントからラスタライズして埋め込む。
# 実行環境: macOS（ヒラギノ角ゴシック）+ Pillow。生成物はコミットするため、
# 利用者がこのスクリプトを実行する必要はない。
#   python3 scripts/gen-og-font.py > src/og-font.ts
import json
import sys

from PIL import Image, ImageDraw, ImageFont

FONT_PATH = "/System/Library/Fonts/ヒラギノ角ゴシック W6.ttc"
SIZE = 28  # ベースの字面サイズ（描画時はそのまま使う）
CHARSET = "0123456789./%-+:kg 体重脂肪率除日平均"


def render_glyph(font: ImageFont.FreeTypeFont, ch: str):
    # 余白込みで描画してからバウンディングボックスで切り出す
    pad = SIZE
    img = Image.new("L", (SIZE * 3, SIZE * 3), 0)
    draw = ImageDraw.Draw(img)
    draw.text((pad, pad), ch, fill=255, font=font)
    bbox = img.getbbox()
    if bbox is None:  # 空白など
        adv = round(font.getlength(ch))
        return {"w": adv, "h": 0, "ox": 0, "oy": 0, "adv": adv, "rows": []}
    left, top, right, bottom = bbox
    cropped = img.crop(bbox)
    rows = []
    for y in range(cropped.height):
        row = "".join(format(cropped.getpixel((x, y)) >> 4, "x") for x in range(cropped.width))
        rows.append(row)
    return {
        "w": cropped.width,
        "h": cropped.height,
        "ox": left - pad,  # 描画原点からのオフセット
        "oy": top - pad,
        "adv": round(font.getlength(ch)),
        "rows": rows,
    }


def main():
    font = ImageFont.truetype(FONT_PATH, SIZE)
    glyphs = {ch: render_glyph(font, ch) for ch in CHARSET}
    meta = {"size": SIZE, "ascent": font.getmetrics()[0]}
    out = {"meta": meta, "glyphs": glyphs}
    sys.stdout.write("// 自動生成ファイル。編集しない: python3 scripts/gen-og-font.py > src/og-font.ts\n")
    sys.stdout.write("// 各グリフ: w/h=ビットマップ寸法, ox/oy=原点オフセット, adv=送り幅, rows=4bitアルファ(16進)\n")
    sys.stdout.write("export interface OgGlyph { w: number; h: number; ox: number; oy: number; adv: number; rows: string[] }\n")
    sys.stdout.write("export const OG_FONT: { meta: { size: number; ascent: number }; glyphs: Record<string, OgGlyph> } = ")
    sys.stdout.write(json.dumps(out, ensure_ascii=False, separators=(",", ":")))
    sys.stdout.write(";\n")


if __name__ == "__main__":
    main()
