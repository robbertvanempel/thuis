"""Private chat attachments, uploaded before a message is committed."""
from __future__ import annotations

import hashlib
import os
import re
import tempfile
import time
import uuid
from pathlib import Path
from urllib.parse import unquote

MAX_FILE_SIZE = 25 * 1024 * 1024
MAX_FILES = 5
IMAGE_TYPES = {"image/png", "image/jpeg", "image/gif", "image/webp"}


class MessageConflict(ValueError):
    pass


def initialize(connection):
    connection.execute("""CREATE TABLE IF NOT EXISTS chat_attachments (
        id TEXT PRIMARY KEY, message_id INTEGER REFERENCES chat_messages(id) ON DELETE CASCADE,
        username TEXT NOT NULL REFERENCES users(username), upload_id TEXT NOT NULL,
        filename TEXT NOT NULL, media_type TEXT NOT NULL, size INTEGER NOT NULL,
        sha256 TEXT NOT NULL, created_at INTEGER NOT NULL,
        UNIQUE(username, upload_id)
    )""")
    connection.execute("CREATE INDEX IF NOT EXISTS chat_attachments_message ON chat_attachments(message_id)")


def describe(row):
    return {name: row[name] for name in ("id", "filename", "media_type", "size")}


def messages(connection, rows):
    items = [dict(row, attachments=[]) for row in rows]
    by_id = {item["id"]: item for item in items}
    if items:
        marks = ",".join("?" for _ in items)
        for row in connection.execute(f"SELECT * FROM chat_attachments WHERE message_id IN ({marks}) ORDER BY created_at,id", tuple(by_id)):
            by_id[row["message_id"]]["attachments"].append(describe(row))
    return items


def cleanup(connection, folder):
    """Only abandoned uploads expire. Sent attachments are never removed here."""
    cutoff = int(time.time()) - 86400
    connection.execute("BEGIN IMMEDIATE")
    try:
        stale = connection.execute("SELECT id FROM chat_attachments WHERE message_id IS NULL AND created_at<?", (cutoff,)).fetchall()
        for row in stale:
            (folder / row["id"]).unlink(missing_ok=True)
        connection.execute("DELETE FROM chat_attachments WHERE message_id IS NULL AND created_at<?", (cutoff,))
        connection.commit()
    except Exception:
        connection.rollback()
        raise
    for candidate in folder.iterdir():
        try:
            expired = candidate.is_file() and candidate.stat().st_mtime < cutoff
        except FileNotFoundError:
            continue
        if expired:
            if candidate.name.startswith(".upload-") or (
                re.fullmatch(r"[a-f0-9]{32}", candidate.name)
                and not connection.execute("SELECT 1 FROM chat_attachments WHERE id=?", (candidate.name,)).fetchone()
            ):
                candidate.unlink(missing_ok=True)


def store_upload(connection, folder: Path, user, headers, stream):
    length = int(headers.get("Content-Length", "-1"))
    if headers.get("Transfer-Encoding") or not 0 <= length <= MAX_FILE_SIZE:
        raise ValueError("Kies een bestand van maximaal 25 MB.")
    upload_id = headers.get("X-Chat-Upload-ID", "")
    if not re.fullmatch(r"[A-Za-z0-9_-]{16,80}", upload_id):
        raise ValueError("Ongeldig uploadnummer. Kies het bestand opnieuw.")
    filename = unquote(headers.get("X-File-Name", ""))
    filename = re.sub(r"[\x00-\x1f\x7f]", "", filename.replace("\\", "/").split("/")[-1]).strip()[:240]
    if not filename or filename in (".", ".."):
        raise ValueError("De bestandsnaam ontbreekt.")
    folder.mkdir(mode=0o700, parents=True, exist_ok=True)
    cleanup(connection, folder)
    fd, name = tempfile.mkstemp(prefix=".upload-", dir=folder)
    temporary = Path(name)
    file_id = uuid.uuid4().hex
    destination = folder / file_id
    committed = False
    try:
        digest = hashlib.sha256()
        head = b""
        with os.fdopen(fd, "wb") as handle:
            remaining = length
            while remaining:
                chunk = stream.read(min(remaining, 65536))
                if not chunk:
                    raise ValueError("Het bestand kwam niet helemaal aan. Probeer opnieuw.")
                if len(head) < 16:
                    head += chunk[:16 - len(head)]
                handle.write(chunk)
                digest.update(chunk)
                remaining -= len(chunk)
            handle.flush()
            os.fsync(handle.fileno())
        media_type = "application/octet-stream"
        if head.startswith(b"\x89PNG\r\n\x1a\n"):
            media_type = "image/png"
        elif head.startswith(b"\xff\xd8\xff"):
            media_type = "image/jpeg"
        elif head.startswith((b"GIF87a", b"GIF89a")):
            media_type = "image/gif"
        elif head[:4] == b"RIFF" and head[8:12] == b"WEBP":
            media_type = "image/webp"
        connection.execute("BEGIN IMMEDIATE")
        existing = connection.execute("SELECT * FROM chat_attachments WHERE username=? AND upload_id=?", (user, upload_id)).fetchone()
        if existing:
            if existing["sha256"] != digest.hexdigest() or existing["filename"] != filename or existing["size"] != length:
                raise ValueError("Dit uploadnummer is al gebruikt. Kies het bestand opnieuw.")
            if not (folder / existing["id"]).is_file():
                raise ValueError("Deze upload is niet meer beschikbaar. Kies het bestand opnieuw.")
            connection.commit()
            return describe(existing)
        if connection.execute("SELECT count(*) FROM chat_attachments WHERE username=? AND message_id IS NULL", (user,)).fetchone()[0] >= 20:
            raise ValueError("Er staan te veel losse uploads klaar. Verstuur je huidige bestanden eerst.")
        os.replace(temporary, destination)
        connection.execute("""INSERT INTO chat_attachments(id,username,upload_id,filename,media_type,size,sha256,created_at)
            VALUES(?,?,?,?,?,?,?,?)""", (file_id, user, upload_id, filename, media_type, length, digest.hexdigest(), int(time.time())))
        connection.commit()
        committed = True
        return describe(connection.execute("SELECT * FROM chat_attachments WHERE id=?", (file_id,)).fetchone())
    finally:
        if connection.in_transaction:
            connection.rollback()
        temporary.unlink(missing_ok=True)
        if not committed:
            destination.unlink(missing_ok=True)


def create_message(connection, folder, user, payload, timestamp):
    if not isinstance(payload, dict):
        raise ValueError("Ongeldig bericht.")
    body = payload.get("body", "")
    client_id = payload.get("client_id")
    ids = payload.get("attachment_ids", [])
    if (not isinstance(ids, list) or len(ids) > MAX_FILES
            or any(not isinstance(value, str) or not re.fullmatch(r"[a-f0-9]{32}", value) for value in ids)
            or len(set(ids)) != len(ids)):
        raise ValueError("Kies maximaal vijf verschillende bestanden.")
    if not isinstance(body, str) or len(body) > 4000 or (not body.strip() and not ids):
        raise ValueError("Schrijf een bericht van maximaal 4000 tekens of kies een bestand.")
    if not isinstance(client_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]{16,80}", client_id):
        raise ValueError("Ongeldig berichtnummer. Herlaad de pagina.")
    connection.execute("BEGIN IMMEDIATE")
    existing = connection.execute("SELECT * FROM chat_messages WHERE username=? AND client_id=?", (user, client_id)).fetchone()
    if existing:
        attached = {row[0] for row in connection.execute("SELECT id FROM chat_attachments WHERE message_id=?", (existing["id"],))}
        if existing["body"] != body.strip() or attached != set(ids):
            raise MessageConflict("Dit berichtnummer is al gebruikt. Herlaad de pagina.")
        connection.commit()
        return messages(connection, [existing])[0]
    for file_id in ids:
        record = connection.execute("SELECT * FROM chat_attachments WHERE id=? AND username=? AND message_id IS NULL", (file_id, user)).fetchone()
        if not record or not (folder / file_id).is_file():
            raise ValueError("Een bestand is niet meer beschikbaar. Verwijder het uit je bericht en kies het opnieuw.")
    cursor = connection.execute("INSERT INTO chat_messages(client_id,username,body,created_at) VALUES(?,?,?,?)", (client_id, user, body.strip(), timestamp))
    message_id = cursor.lastrowid
    for file_id in ids:
        connection.execute("UPDATE chat_attachments SET message_id=? WHERE id=?", (message_id, file_id))
    connection.commit()
    return messages(connection, [connection.execute("SELECT * FROM chat_messages WHERE id=?", (message_id,)).fetchone()])[0]
