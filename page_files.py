"""Durable, streamed page attachments; never served from the public webroot."""
import hashlib
import os
import re
import tempfile
import uuid
from pathlib import Path
from urllib.parse import unquote, quote

MAX_FILE_SIZE = 100 * 1024 * 1024
INLINE_TYPES = {'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf', 'video/mp4', 'video/webm', 'video/quicktime', 'audio/mpeg', 'audio/ogg', 'audio/wav', 'audio/mp4'}


class UploadError(ValueError):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


def initialize(connection):
    columns = {row[1] for row in connection.execute('PRAGMA table_info(files)')}
    for name in ('upload_id', 'sha256'):
        if name not in columns:
            connection.execute(f'ALTER TABLE files ADD COLUMN {name} TEXT')
    connection.execute('CREATE UNIQUE INDEX IF NOT EXISTS page_file_upload ON files(page_id, username, upload_id)')


def media_type(head, filename):
    """Only recognizable passive formats may be previewed inline."""
    if head.startswith(b'\x89PNG\r\n\x1a\n'): return 'image/png'
    if head.startswith(b'\xff\xd8\xff'): return 'image/jpeg'
    if head.startswith((b'GIF87a', b'GIF89a')): return 'image/gif'
    if head[:4] == b'RIFF' and head[8:12] == b'WEBP': return 'image/webp'
    if head.startswith(b'%PDF-'): return 'application/pdf'
    suffix = Path(filename).suffix.lower()
    if head[4:8] == b'ftyp':
        if suffix == '.mov': return 'video/quicktime'
        if suffix == '.m4a': return 'audio/mp4'
        if suffix in ('.mp4', '.m4v'): return 'video/mp4'
    if head.startswith(b'\x1aE\xdf\xa3') and suffix == '.webm': return 'video/webm'
    if (head.startswith(b'ID3') or (len(head) > 1 and head[0] == 255 and head[1] & 224 == 224)) and suffix == '.mp3': return 'audio/mpeg'
    if head.startswith(b'OggS') and suffix in ('.ogg', '.oga'): return 'audio/ogg'
    if head[:4] == b'RIFF' and head[8:12] == b'WAVE': return 'audio/wav'
    return 'application/octet-stream'


def describe(row):
    return {key: row[key] for key in ('id', 'filename', 'media_type', 'size')}


def store_upload(connection, folder, page_id, user, headers, stream, timestamp):
    try:
        length = int(headers.get('Content-Length', '-1'))
    except ValueError:
        raise UploadError('De bestandsgrootte ontbreekt.')
    if headers.get('Transfer-Encoding') or not 0 < length <= MAX_FILE_SIZE:
        raise UploadError('Kies een niet-leeg bestand van maximaal 100 MB.', 413)
    upload_id = headers.get('X-Page-Upload-ID', '')
    if not re.fullmatch(r'[A-Za-z0-9_-]{16,80}', upload_id):
        raise UploadError('Ongeldig uploadnummer. Kies het bestand opnieuw.')
    filename = unquote(headers.get('X-File-Name', ''))
    filename = re.sub(r'[\x00-\x1f\x7f]', '', filename.replace('\\', '/').split('/')[-1]).strip()[:240]
    if not filename or filename in ('.', '..'):
        raise UploadError('De bestandsnaam ontbreekt.')
    if not connection.execute('SELECT 1 FROM pages WHERE id=? AND deleted_at IS NULL', (page_id,)).fetchone():
        raise UploadError('Pagina niet gevonden.', 404)
    folder.mkdir(mode=0o700, parents=True, exist_ok=True)
    fd, temporary_name = tempfile.mkstemp(prefix='.upload-', dir=folder)
    temporary = Path(temporary_name)
    file_id = uuid.uuid4().hex
    destination = folder / file_id
    committed = False
    try:
        digest, head = hashlib.sha256(), b''
        with os.fdopen(fd, 'wb') as handle:
            remaining = length
            while remaining:
                chunk = stream.read(min(remaining, 65536))
                if not chunk:
                    raise UploadError('De upload is onderbroken. Probeer opnieuw.')
                if len(head) < 32: head += chunk[:32-len(head)]
                handle.write(chunk)
                digest.update(chunk)
                remaining -= len(chunk)
            handle.flush()
            os.fsync(handle.fileno())
        connection.execute('BEGIN IMMEDIATE')
        # Check again after upload: the page could have been trashed in the meantime.
        if not connection.execute('SELECT 1 FROM pages WHERE id=? AND deleted_at IS NULL', (page_id,)).fetchone():
            raise UploadError('Deze pagina is intussen verwijderd.', 404)
        existing = connection.execute('SELECT * FROM files WHERE page_id=? AND username=? AND upload_id=?', (page_id, user, upload_id)).fetchone()
        if existing:
            if existing['sha256'] != digest.hexdigest() or existing['filename'] != filename or existing['size'] != length:
                raise UploadError('Dit uploadnummer is al gebruikt voor een ander bestand.', 409)
            if not (folder / existing['id']).is_file():
                raise UploadError('Het opgeslagen bestand ontbreekt.', 409)
            connection.commit()
            return describe(existing)
        os.replace(temporary, destination)
        # Persist the directory entry before acknowledging the database record.
        # Windows cannot open directories through os.open. The file itself was
        # flushed above and os.replace still performs the atomic rename.
        if os.name != 'nt':
            directory_fd = os.open(folder, os.O_RDONLY)
            try: os.fsync(directory_fd)
            finally: os.close(directory_fd)
        connection.execute('INSERT INTO files(id,page_id,username,filename,media_type,size,created_at,upload_id,sha256) VALUES(?,?,?,?,?,?,?,?,?)',
            (file_id, page_id, user, filename, media_type(head, filename), length, timestamp, upload_id, digest.hexdigest()))
        connection.commit()
        committed = True
        return describe(connection.execute('SELECT * FROM files WHERE id=?', (file_id,)).fetchone())
    finally:
        if connection.in_transaction: connection.rollback()
        temporary.unlink(missing_ok=True)
        if not committed: destination.unlink(missing_ok=True)


def serve(handler, folder, record, preview=False):
    path = folder / record['id']
    try: handle = path.open('rb')
    except FileNotFoundError:
        handler.send_json({'error': 'Bestand niet gevonden.'}, 404)
        return
    with handle:
        size = os.fstat(handle.fileno()).st_size
        # Sniff old uploads too: historical metadata came from the browser.
        kind = media_type(handle.read(32), record['filename'])
        handle.seek(0)
        inline = preview and kind in INLINE_TYPES
        start, end, status = 0, size - 1, 200
        requested = handler.headers.get('Range')
        if requested:
            match = re.fullmatch(r'bytes=(\d*)-(\d*)', requested)
            try:
                if not match or not any(match.groups()) or not size: raise ValueError()
                left, right = match.groups()
                if left:
                    start = int(left)
                    end = min(int(right), size - 1) if right else size - 1
                else:
                    if int(right) <= 0: raise ValueError()
                    start = max(0, size - int(right))
                if start > end or start >= size: raise ValueError()
                status = 206
            except ValueError:
                handler.send_json({'error': 'Ongeldig bytebereik.'}, 416, {'Content-Range': f'bytes */{size}'})
                return
        handler.send_response(status)
        handler.send_header('Content-Type', kind if inline else 'application/octet-stream')
        handler.send_header('Content-Length', str(max(0, end - start + 1)))
        handler.send_header('Accept-Ranges', 'bytes')
        if status == 206: handler.send_header('Content-Range', f'bytes {start}-{end}/{size}')
        handler.send_header('Content-Disposition', f"{'inline' if inline else 'attachment'}; filename*=UTF-8''{quote(record['filename'], safe='')}")
        handler.send_header('Cache-Control', 'private, no-store')
        handler.send_header('X-Content-Type-Options', 'nosniff')
        handler.send_header('Referrer-Policy', 'no-referrer')
        handler.send_header('X-Frame-Options', 'SAMEORIGIN')
        # Native PDF viewers cannot run in a CSP-sandboxed document. The MIME is
        # signature-checked and nosniff; all other downloads retain the sandbox.
        policy = "default-src 'none'; frame-ancestors 'self'"
        if not (inline and kind == 'application/pdf'): policy += '; sandbox'
        handler.send_header('Content-Security-Policy', policy)
        handler.end_headers()
        handle.seek(start)
        remaining = end - start + 1
        try:
            while remaining > 0:
                chunk = handle.read(min(remaining, 65536))
                if not chunk: break
                handler.wfile.write(chunk)
                remaining -= len(chunk)
        except (BrokenPipeError, ConnectionResetError):
            pass  # Seeking or navigating away may cancel a media request.
