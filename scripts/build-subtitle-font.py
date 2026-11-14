"""Convert the pinned OFL font release to the locally served subtitle font.

Requires fonttools==4.68.0 and brotli==1.2.1. Run with the upstream release ZIP:
python scripts/build-subtitle-font.py path/to/ChillRoundF_v3.200.zip
No glyphs are subsetted; renamed to respect the upstream Reserved Font Names.
"""
from hashlib import sha256
from io import BytesIO
from pathlib import Path
import sys
from zipfile import ZipFile

from fontTools.ttLib import TTFont

root = Path(__file__).resolve().parent.parent
with ZipFile(sys.argv[1]) as archive:
    source = archive.read("ChillRoundF_v3.200/ChillRoundFBold.ttf")
    license_text = archive.read("ChillRoundF_v3.200/LICENSE.txt").decode("utf-8-sig")
assert sha256(source).hexdigest() == "f2c4f9295d9d04a1eb6392ae3c51ecf2a9ffab355a45c6686eeec5eede3381ec"
font = TTFont(BytesIO(source), recalcTimestamp=False)
codepoints = set(font.getBestCmap())
assert font["OS/2"].usWeightClass == 700
names = {
    1: "Sully Subtitle Rounded", 2: "Bold", 3: "SullySubtitleRounded-Bold-3.200",
    4: "Sully Subtitle Rounded Bold", 6: "SullySubtitleRounded-Bold",
    16: "Sully Subtitle Rounded", 17: "Bold", 21: "Sully Subtitle Rounded", 22: "Bold",
}
for record in font["name"].names:
    if record.nameID in names:
        record.string = names[record.nameID].encode(record.getEncoding())
font.flavor = "woff2"
output = root / "assets/fonts/subtitle-rounded-bold.woff2"
output.parent.mkdir(parents=True, exist_ok=True)
font.save(output)
assert set(TTFont(output).getBestCmap()) == codepoints
(root / "public/licenses/subtitle-rounded-OFL.txt").write_text(license_text, encoding="utf-8")
print(f"Created {output.name}: {output.stat().st_size} bytes, {len(codepoints)} codepoints")
