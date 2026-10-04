"""Private, account-scoped profile pictures."""
from io import BytesIO
import os
from pathlib import Path
import tempfile

from config import MEMBERS as HOUSEHOLD_MEMBERS
from PIL import Image, ImageOps

MAX_UPLOAD = 10 * 1024 * 1024
MAX_PIXELS = 40_000_000
MEMBERS = {name: f"member{i+1}" for i, name in enumerate(HOUSEHOLD_MEMBERS)}


def avatar_path(folder: Path, username: str) -> Path:
    name = MEMBERS[username]
    current = folder / f"{name}.avatar.png"
    return current


def versions(folder: Path) -> dict:
    result = {}
    for username in MEMBERS:
        try:
            stat = avatar_path(folder, username).stat()
            result[username] = f"{stat.st_mtime_ns}-{stat.st_size}"
        except FileNotFoundError:
            result[username] = "none"
    return result


def save(folder: Path, username: str, headers, stream) -> None:
    if username not in MEMBERS:
        raise ValueError("Dit account kan geen profielfoto wijzigen.")
    if headers.get("Transfer-Encoding"):
        raise ValueError("De foto kon niet worden ontvangen. Probeer opnieuw.")
    try:
        length = int(headers.get("Content-Length", "0"))
    except ValueError:
        raise ValueError("Ongeldige fotogrootte.") from None
    if not 0 < length <= MAX_UPLOAD:
        raise ValueError("Kies een foto van maximaal 10 MB.")
    content = stream.read(length)
    if len(content) != length:
        raise ValueError("De foto is niet volledig ontvangen. Probeer opnieuw.")
    try:
        with Image.open(BytesIO(content), formats=("JPEG", "PNG", "WEBP")) as original:
            if original.width * original.height > MAX_PIXELS:
                raise ValueError("Deze foto is te groot. Kies een foto van maximaal 40 megapixels.")
            original.load()
            oriented = ImageOps.exif_transpose(original)
            square = ImageOps.fit(oriented.convert("RGBA"), (512, 512), method=Image.Resampling.LANCZOS)
            # Re-encode pixels only, without location, EXIF, text or other source metadata.
            clean = Image.new("RGBA", (512, 512))
            clean.paste(square)
            output = BytesIO()
            clean.save(output, format="PNG")
    except (OSError, Image.DecompressionBombError, SyntaxError):
        raise ValueError("Deze foto kan niet worden geopend. Kies een JPG-, PNG- of WebP-foto.") from None
    folder.mkdir(mode=0o700, parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=".avatar-", dir=folder)
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(output.getvalue())
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, folder / f"{MEMBERS[username]}.avatar.png")
    finally:
        Path(temporary).unlink(missing_ok=True)
