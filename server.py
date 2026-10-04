#!/usr/bin/env python3
"""Small authenticated application server for the Thuis family dashboard."""
from __future__ import annotations

import argparse
import base64
import getpass
import hashlib
import hmac
import json
import mimetypes
import os
import re
import secrets
import shutil
import sqlite3
import sys
import threading
import time
import uuid
from datetime import datetime, timedelta, timezone
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, quote, unquote, urlparse
from zoneinfo import ZoneInfo
import config
from config import MEMBERS
import nextcloud_client
import push_notifications
import chat_files
import page_files
import profile_images
import task_reminders

APP_DIR = Path(__file__).resolve().parent
ASSET_DIR = Path(os.environ.get("FAMILY_DASHBOARD_PUBLIC_DIR", APP_DIR)).expanduser()
PRIVATE_DIR = Path(os.environ.get("FAMILY_DASHBOARD_DATA", config.PRIVATE_DIR)).expanduser()
DB_PATH = PRIVATE_DIR / "family-dashboard.sqlite3"
UPLOAD_DIR = PRIVATE_DIR / "files"
CHAT_UPLOAD_DIR = PRIVATE_DIR / "chat-files"
PROFILE_DIR = PRIVATE_DIR / "profiles"
MAX_BODY = 12 * 1024 * 1024
SESSION_DAYS = 21
PBKDF2_ROUNDS = 310_000
TZ = ZoneInfo("Europe/Amsterdam")
# A private deployment file can override the systemd environment during domain moves.
ORIGINS_FILE = PRIVATE_DIR / "allowed-origins.json"
if ORIGINS_FILE.is_file():
    configured_origins = json.loads(ORIGINS_FILE.read_text(encoding="utf-8"))
    if not isinstance(configured_origins, list) or not configured_origins or any(
        not isinstance(value, str) or urlparse(value).scheme != "https" or not urlparse(value).netloc
        or urlparse(value).path or urlparse(value).query or urlparse(value).fragment
        for value in configured_origins
    ):
        raise ValueError("Invalid allowed-origins.json configuration")
else:
    configured_origins = [value.strip() for value in os.environ.get("FAMILY_DASHBOARD_ORIGINS", "").split(",") if value.strip()]
ALLOWED_ORIGINS = frozenset(value.lower() for value in configured_origins)
LOGIN_ATTEMPTS: dict[str, list[float]] = {}
LOGIN_LOCK = threading.Lock()
SETUP_LOCK = threading.Lock()
SETUP_TOKEN = secrets.token_urlsafe(32)
DB_SCHEMA_LOCK = threading.Lock()
PUSH_SERVICE = None


def task_due_date(value):
    if value is None or value == "":
        return None
    if not isinstance(value, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
        raise ValueError("Kies een geldige datum.")
    try:
        datetime.strptime(value, "%Y-%m-%d")
    except ValueError:
        raise ValueError("Kies een geldige datum.")
    return value


def db() -> sqlite3.Connection:
    PRIVATE_DIR.mkdir(mode=0o700, parents=True, exist_ok=True)
    UPLOAD_DIR.mkdir(mode=0o700, parents=True, exist_ok=True)
    connection = sqlite3.connect(DB_PATH, timeout=15)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA journal_mode=WAL")
    connection.execute("PRAGMA foreign_keys=ON")
    connection.executescript("""
      CREATE TABLE IF NOT EXISTS users (username TEXT PRIMARY KEY, password_hash TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, username TEXT NOT NULL REFERENCES users(username) ON DELETE CASCADE, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS chat_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, client_id TEXT NOT NULL, username TEXT NOT NULL REFERENCES users(username), body TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(username,client_id));
      CREATE TABLE IF NOT EXISTS chat_reads (username TEXT PRIMARY KEY REFERENCES users(username), last_id INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, title TEXT NOT NULL, list_key TEXT NOT NULL, due_date TEXT, done INTEGER NOT NULL DEFAULT 0, created_by TEXT NOT NULL, created_at TEXT NOT NULL, sort_order INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS pages (id TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', updated_by TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS comments (id TEXT PRIMARY KEY, page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE, username TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS files (id TEXT PRIMARY KEY, page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE, username TEXT NOT NULL, filename TEXT NOT NULL, media_type TEXT NOT NULL, size INTEGER NOT NULL, created_at TEXT NOT NULL);
    """)
    with DB_SCHEMA_LOCK:
        push_notifications.initialize(connection)
        chat_files.initialize(connection)
        page_files.initialize(connection)
        columns = {row["name"] for row in connection.execute("PRAGMA table_info(pages)")}
        for name, definition in (("sort_order", "INTEGER NOT NULL DEFAULT 0"), ("parent_id", "TEXT REFERENCES pages(id)"), ("deleted_at", "TEXT"), ("deleted_batch", "TEXT")):
            if name not in columns:
                connection.execute(f"ALTER TABLE pages ADD COLUMN {name} {definition}")
        task_columns = {row["name"] for row in connection.execute("PRAGMA table_info(tasks)")}
        if "assigned_to" not in task_columns:
            connection.execute("ALTER TABLE tasks ADD COLUMN assigned_to TEXT")
        task_reminders.initialize(connection)
        connection.execute("CREATE INDEX IF NOT EXISTS pages_parent_idx ON pages(parent_id)")
        connection.commit()
    os.chmod(DB_PATH, 0o600)
    return connection


def pbkdf2(password: str, salt: bytes | None = None) -> str:
    salt = salt or secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, PBKDF2_ROUNDS)
    return f"pbkdf2_sha256${PBKDF2_ROUNDS}${base64.urlsafe_b64encode(salt).decode()}${base64.urlsafe_b64encode(digest).decode()}"


def check_password(password: str, value: str) -> bool:
    try:
        _algorithm, rounds, salt, digest = value.split("$", 3)
        candidate = hashlib.pbkdf2_hmac("sha256", password.encode(), base64.urlsafe_b64decode(salt), int(rounds))
        return hmac.compare_digest(base64.urlsafe_b64encode(candidate).decode(), digest)
    except (ValueError, TypeError):
        return False


def add_user(username: str) -> None:
    username = username.strip()[:80]
    if not username:
        raise SystemExit("Naam mag niet leeg zijn.")
    password = getpass.getpass(f"Nieuw wachtwoord voor {username}: ")
    confirm = getpass.getpass("Herhaal wachtwoord: ")
    if len(password) < 12 or password != confirm:
        raise SystemExit("Wachtwoorden moeten overeenkomen en minstens 12 tekens bevatten.")
    connection = db()
    try:
        connection.execute("INSERT INTO users(username,password_hash) VALUES(?,?) ON CONFLICT(username) DO UPDATE SET password_hash=excluded.password_hash", (username, pbkdf2(password)))
        connection.execute("DELETE FROM sessions WHERE username=?", (username,))
        connection.commit()
    finally:
        connection.close()
    print(f"Account ingesteld: {username}")


def iso_now() -> str:
    return datetime.now(TZ).isoformat(timespec="seconds")


def rowdict(row: sqlite3.Row | None):
    return dict(row) if row else None


def validate_parent(connection, parent_id, page_id=None):
    if parent_id is not None and not isinstance(parent_id, str):
        raise ValueError("Kies een geldige bovenliggende pagina.")
    cursor = parent_id
    seen = {page_id} if page_id else set()
    while cursor is not None:
        if cursor in seen:
            raise ValueError("Een pagina kan niet onder zichzelf of haar eigen subpagina worden geplaatst.")
        seen.add(cursor)
        row = connection.execute("SELECT parent_id FROM pages WHERE id=? AND deleted_at IS NULL", (cursor,)).fetchone()
        if not row:
            raise ValueError("De bovenliggende pagina bestaat niet meer. Kies een andere plek.")
        cursor = row["parent_id"]


def active_branch(connection, page_id):
    return [row[0] for row in connection.execute("""
        WITH RECURSIVE branch(id) AS (
          SELECT id FROM pages WHERE id=? AND deleted_at IS NULL
          UNION SELECT p.id FROM pages p JOIN branch b ON p.parent_id=b.id WHERE p.deleted_at IS NULL
        ) SELECT id FROM branch
    """, (page_id,))]


def calendar_feed() -> dict:
    from calendar_feed import read_calendar
    return read_calendar(config.SETTINGS, PRIVATE_DIR)


class Handler(BaseHTTPRequestHandler):
    server_version = "FamilyDashboard/1.0"
    sys_version = ""

    def log_message(self, fmt, *args):
        # Keep request URLs, form bodies and user content out of ordinary logs.
        if self.path.split("?", 1)[0] not in ("/api/me", "/api/agenda", "/api/tasks", "/api/pages"):
            return

    def send_json(self, value, status=200, headers=None):
        body = json.dumps(value, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'")
        for name, value in (headers or {}).items():
            self.send_header(name, value)
        self.end_headers()
        self.wfile.write(body)

    def read_json(self):
        length = int(self.headers.get("Content-Length", "0"))
        if length > MAX_BODY:
            raise ValueError("Verzoek is te groot (maximaal 10 MB).")
        if length == 0:
            return {}
        return json.loads(self.rfile.read(length))

    def check_origin(self):
        origin = self.headers.get("Origin")
        host = self.headers.get("Host", "")
        parsed_origin = urlparse(origin or "")
        same_origin = parsed_origin.netloc.lower() == host.lower() and parsed_origin.scheme in ("http", "https")
        configured_origin = origin is not None and origin.lower() in ALLOWED_ORIGINS
        if not origin or not (configured_origin if ALLOWED_ORIGINS else same_origin):
            self.send_json({"error": "Ongeldige herkomst."}, 403)
            return False
        return True

    def cookie_token(self):
        jar = SimpleCookie()
        try:
            jar.load(self.headers.get("Cookie", ""))
            return jar["family_session"].value
        except Exception:
            return None

    def session_user(self):
        token = self.cookie_token()
        if not token:
            return None
        connection = db()
        try:
            row = connection.execute("SELECT users.username FROM sessions JOIN users USING(username) WHERE token_hash=? AND expires_at>?", (hashlib.sha256(token.encode()).hexdigest(), int(time.time()))).fetchone()
            return row["username"] if row else None
        finally:
            connection.close()

    def require_user(self):
        user = self.session_user()
        if not user:
            self.send_json({"error": "Log opnieuw in."}, 401)
            return None
        return user

    def nextcloud_action(self, user, action, payload=None):
        try:
            actions = {
                "status": lambda: nextcloud_client.status(PRIVATE_DIR, user),
                "connect": lambda: nextcloud_client.connect(PRIVATE_DIR, user),
                "poll": lambda: nextcloud_client.poll(PRIVATE_DIR, user),
                "disconnect": lambda: nextcloud_client.disconnect(PRIVATE_DIR, user),
                "search": lambda: nextcloud_client.search(PRIVATE_DIR, user, (payload or {}).get("term")),
            }
            if action not in actions:
                self.send_json({"error": "Niet gevonden."},404)
                return
            self.send_json(actions[action]())
        except nextcloud_client.CloudError as error:
            self.send_json({"error":str(error)},error.status)
        except Exception:
            self.send_json({"error":"De Nextcloud-koppeling is tijdelijk niet beschikbaar. Probeer opnieuw."},502)

    def do_GET(self):
        path = unquote(urlparse(self.path).path)
        if path == "/dashboard":
            self.send_response(308)
            self.send_header("Location", "/dashboard/")
            self.end_headers()
            return
        if path.startswith("/dashboard/api/"):
            path = path.removeprefix("/dashboard")
        public_assets = {"manifest.webmanifest", "sw.js", "assets/icon-192.png", "assets/icon-512.png", "assets/notification-badge.png", "assets/favicon.svg","assets/page-editor.js", "assets/pdf-worker.mjs", "assets/pdfjs/LICENSE", "index.html", "setup.html", "setup.js", "app.js", "styles.css", "assets/fonts/space-grotesk-variable.ttf", "assets/fonts/inter-variable.woff2"}
        asset_name = path.removeprefix("/dashboard/") if path.startswith("/dashboard/") else path.removeprefix("/") if path.startswith("/") else ""
        pdf_asset = bool(re.fullmatch(r"assets/pdfjs/(?:cmaps|standard_fonts)/[A-Za-z0-9_.-]+", asset_name)) and (ASSET_DIR / asset_name).is_file()
        if path in ("/", "/dashboard/") or asset_name in public_assets or pdf_asset:
            filename = "index.html" if path.endswith("/") else asset_name
            content = (ASSET_DIR / filename).read_bytes()
            self.send_response(200)
            asset_types = {"manifest.webmanifest": "application/manifest+json","assets/fonts/inter-variable.woff2": "font/woff2", "assets/fonts/space-grotesk-variable.ttf": "font/ttf", "assets/pdf-worker.mjs": "text/javascript"}
            self.send_header("Content-Type", asset_types.get(filename) or mimetypes.guess_type(filename)[0] or "application/octet-stream")
            self.send_header("Content-Length", str(len(content)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Referrer-Policy", "no-referrer")
            self.send_header("X-Frame-Options", "DENY")
            self.send_header("Content-Security-Policy", "default-src 'self'; connect-src 'self' https://api.open-meteo.com; img-src 'self' data: blob:; style-src 'self'; font-src 'self'; script-src 'self'; media-src 'self'; frame-src 'self' https://www.youtube-nocookie.com https://player.vimeo.com https://open.spotify.com https://docs.google.com https://www.google.com; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'")
            self.end_headers()
            self.wfile.write(content)
            return
        if path == "/api/health":
            self.send_json({"ok": True, "app": "thuis", "instance": os.environ.get("THUIS_INSTANCE", "")})
            return
        if path == "/api/me":
            user = self.session_user()
            if user:
                self.send_json({"authenticated": True, "username": user, "config": config.public_settings()})
            else:
                self.send_json({"authenticated": False}, 401)
            return
        user = self.require_user()
        if not user:
            return
        if path == "/api/push/config":
            self.send_json({"available": bool(PUSH_SERVICE and PUSH_SERVICE.public_key),
                "public_key": PUSH_SERVICE.public_key if PUSH_SERVICE else None})
            return
        if path == "/api/nextcloud/status":
            self.nextcloud_action(user, "status")
            return
        if path in ("/api/profile/member1/avatar", "/api/profile/member2/avatar"):
            username = MEMBERS[1] if path == "/api/profile/member2/avatar" else MEMBERS[0]
            avatar = profile_images.avatar_path(PROFILE_DIR, username)
            if not avatar.is_file():
                self.send_json({"error": "Geen profielfoto."}, 404)
                return
            content = avatar.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", "image/jpeg" if avatar.suffix == ".jpeg" else "image/png")
            self.send_header("Content-Length", str(len(content)))
            self.send_header("Cache-Control", "private, no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.end_headers()
            self.wfile.write(content)
            return
        connection = db()
        try:
            query = parse_qs(urlparse(self.path).query)
            if path == "/api/agenda":
                self.send_json(calendar_feed())
            elif path == "/api/chat/unread":
                if user not in MEMBERS:
                    self.send_json({"error": "Deze chat is voor de twee ingestelde chataccounts."}, 403)
                    return
                peer = MEMBERS[1] if user == MEMBERS[0] else MEMBERS[0]
                unread = connection.execute("SELECT count(*) FROM chat_messages WHERE username=? AND id>COALESCE((SELECT last_id FROM chat_reads WHERE username=?),0)", (peer,user)).fetchone()[0]
                self.send_json({"unread": unread, "username": user, "config": config.public_settings()})
            elif path == "/api/chat":
                if user not in MEMBERS:
                    self.send_json({"error": "Deze chat is voor de twee ingestelde chataccounts."}, 403)
                    return
                try:
                    after = max(0, int(query.get("after", ["0"])[0]))
                    before = max(0, int(query.get("before", ["0"])[0]))
                except ValueError:
                    self.send_json({"error": "Ongeldige berichtpositie."}, 400)
                    return
                if before:
                    rows = list(reversed(connection.execute("SELECT * FROM chat_messages WHERE id<? ORDER BY id DESC LIMIT 100", (before,)).fetchall()))
                elif after:
                    rows = connection.execute("SELECT * FROM chat_messages WHERE id>? ORDER BY id LIMIT 100", (after,)).fetchall()
                else:
                    rows = list(reversed(connection.execute("SELECT * FROM chat_messages ORDER BY id DESC LIMIT 100").fetchall()))
                peer = MEMBERS[1] if user == MEMBERS[0] else MEMBERS[0]
                peer_read = connection.execute("SELECT last_id FROM chat_reads WHERE username=?", (peer,)).fetchone()
                own_read = connection.execute("SELECT last_id FROM chat_reads WHERE username=?", (user,)).fetchone()
                unread = connection.execute("SELECT count(*) FROM chat_messages WHERE username=? AND id>?", (peer, own_read[0] if own_read else 0)).fetchone()[0]
                has_older = bool(rows and connection.execute("SELECT 1 FROM chat_messages WHERE id<? LIMIT 1", (rows[0]["id"],)).fetchone())
                self.send_json({"items": chat_files.messages(connection, rows), "peer": peer, "peer_read": peer_read[0] if peer_read else 0, "unread": unread, "has_older": has_older, "peer_ready": bool(connection.execute("SELECT 1 FROM users WHERE username=?", (peer,)).fetchone()), "profiles": profile_images.versions(PROFILE_DIR)})
            elif path.startswith("/api/chat/files/"):
                if user not in MEMBERS:
                    self.send_json({"error": "Deze chat is voor de twee ingestelde chataccounts."}, 403)
                    return
                file_id = path.removeprefix("/api/chat/files/")
                record = connection.execute("SELECT * FROM chat_attachments WHERE id=? AND message_id IS NOT NULL", (file_id,)).fetchone() if re.fullmatch(r"[a-f0-9]{32}", file_id) else None
                if not record or not (CHAT_UPLOAD_DIR / file_id).is_file():
                    self.send_json({"error": "Bestand niet gevonden."}, 404)
                    return
                inline = query.get("preview") == ["1"] and record["media_type"] in chat_files.IMAGE_TYPES
                with (CHAT_UPLOAD_DIR / file_id).open("rb") as handle:
                    self.send_response(200)
                    self.send_header("Content-Type", record["media_type"] if inline else "application/octet-stream")
                    self.send_header("Content-Length", str(record["size"]))
                    self.send_header("Content-Disposition", f"{'inline' if inline else 'attachment'}; filename*=UTF-8''{quote(record['filename'], safe='')}")
                    self.send_header("Cache-Control", "private, no-store")
                    self.send_header("X-Content-Type-Options", "nosniff")
                    self.send_header("Content-Security-Policy", "default-src 'none'; sandbox")
                    self.send_header("Referrer-Policy", "no-referrer")
                    self.end_headers()
                    try:
                        shutil.copyfileobj(handle, self.wfile, 65536)
                    except (BrokenPipeError, ConnectionResetError):
                        pass
            elif path == "/api/tasks":
                list_key = query.get("list", ["today"])[0]
                rows = connection.execute("SELECT * FROM tasks WHERE (list_key=? OR ?='all') AND done=0 ORDER BY due_date IS NULL, due_date, sort_order,created_at,id", (list_key, list_key)).fetchall()
                self.send_json({"items": [task_reminders.public_task(row) for row in rows]})
            elif path.startswith("/api/tasks/") and path.endswith("/reminder"):
                task_id = path.removeprefix("/api/tasks/").removesuffix("/reminder")
                task = connection.execute("SELECT * FROM tasks WHERE id=?", (task_id,)).fetchone()
                available = task_reminders.available(task, user)
                self.send_json({"username": user, "available": available,
                    "reminder_token": task["reminder_token"] if available else None,
                    "title": task["title"] if available else None})
            elif path == "/api/pages":
                trashed = query.get("trash", ["0"])[0] == "1"
                condition = "IS NOT NULL" if trashed else "IS NULL"
                rows = connection.execute(f"SELECT id,title,parent_id,sort_order,deleted_at,deleted_batch,updated_by,updated_at FROM pages WHERE deleted_at {condition} ORDER BY sort_order, title COLLATE NOCASE, id").fetchall()
                count = connection.execute("SELECT count(*) FROM pages WHERE deleted_at IS NOT NULL").fetchone()[0]
                self.send_json({"items": [rowdict(row) for row in rows], "trash_count": count})
            elif path.startswith("/api/pages/"):
                page_id = path.removeprefix("/api/pages/")
                page = connection.execute("SELECT * FROM pages WHERE id=? AND deleted_at IS NULL", (page_id,)).fetchone()
                if not page:
                    self.send_json({"error": "Pagina niet gevonden."}, 404)
                    return
                comments = connection.execute("SELECT id,username,body,created_at FROM comments WHERE page_id=? ORDER BY created_at", (page_id,)).fetchall()
                files = connection.execute("SELECT id,username,filename,media_type,size,created_at FROM files WHERE page_id=? ORDER BY created_at", (page_id,)).fetchall()
                self.send_json({"page": rowdict(page), "comments": [rowdict(row) for row in comments], "files": [rowdict(row) for row in files]})
            elif path.startswith("/api/files/"):
                file_id = path.removeprefix("/api/files/")
                record = connection.execute("SELECT f.* FROM files f JOIN pages p ON p.id=f.page_id WHERE f.id=? AND p.deleted_at IS NULL", (file_id,)).fetchone()
                if not record:
                    self.send_json({"error": "Bestand niet gevonden."}, 404)
                    return
                page_files.serve(self, UPLOAD_DIR, record, query.get("preview") == ["1"])
            else:
                self.send_json({"error": "Niet gevonden."}, 404)
        finally:
            connection.close()

    def setup_household(self):
        # The random first-run capability is printed locally; never returned by an API.
        if self.client_address[0] not in ("127.0.0.1", "::1"):
            self.send_json({"error": "Open de installatie op deze computer."}, 403)
            return
        try:
            payload = self.read_json()
            if not secrets.compare_digest(str(payload.get("token", "")), SETUP_TOKEN):
                self.send_json({"error": "Ongeldige installatielink."}, 403)
                return
            names = payload.get("members")
            config.validate_members(names)
            passwords = payload.get("passwords")
            if not isinstance(passwords, list) or len(passwords) != 2 or any(not isinstance(v, str) or not 12 <= len(v) <= 1024 for v in passwords):
                raise ValueError("Kies twee wachtwoorden van minimaal 12 tekens.")
            hashes = [pbkdf2(value) for value in passwords]
            with SETUP_LOCK:
                connection = db()
                try:
                    connection.execute("BEGIN IMMEDIATE")
                    if connection.execute("SELECT count(*) FROM users").fetchone()[0]:
                        self.send_json({"error": "Thuis is al ingesteld."}, 409)
                        return
                    config.save_members(names)
                    connection.executemany("INSERT INTO users VALUES (?,?)", zip(names, hashes))
                    connection.commit()
                    profile_images.MEMBERS.clear()
                    profile_images.MEMBERS.update({name: f"member{i+1}" for i, name in enumerate(MEMBERS)})
                    self.send_json({"ok": True}, 201)
                finally:
                    connection.close()
        except (ValueError, TypeError, json.JSONDecodeError) as error:
            self.send_json({"error": str(error)}, 400)

    def do_POST(self):
        path = unquote(urlparse(self.path).path)
        if not self.check_origin():
            return
        if path.startswith("/dashboard/api/"):
            path = path.removeprefix("/dashboard")
        if path == "/api/setup":
            self.setup_household()
            return
        if path == "/api/profile/avatar":
            user = self.require_user()
            if not user:
                return
            if user not in profile_images.MEMBERS:
                self.send_json({"error": "Dit account kan geen profielfoto wijzigen."}, 403)
                return
            try:
                self.connection.settimeout(60)
                profile_images.save(PROFILE_DIR, user, self.headers, self.rfile)
                self.send_json({"ok": True, "profiles": profile_images.versions(PROFILE_DIR)})
            except ValueError as error:
                self.close_connection = True
                self.send_json({"error": str(error)}, 400)
            except (TimeoutError, ConnectionResetError, BrokenPipeError):
                self.close_connection = True
            except OSError:
                self.close_connection = True
                self.send_json({"error": "De foto kon niet worden opgeslagen. Probeer opnieuw."}, 503)
            return
        if path.startswith("/api/pages/") and path.endswith("/files") and self.headers.get("Content-Type", "").split(";")[0] != "application/json":
            user = self.require_user()
            if not user:
                self.close_connection = True
                return
            connection = db()
            try:
                self.connection.settimeout(180)
                page_id = path.removeprefix("/api/pages/").removesuffix("/files")
                item = page_files.store_upload(connection, UPLOAD_DIR, page_id, user, self.headers, self.rfile, iso_now())
                self.send_json({"item": item}, 201)
            except page_files.UploadError as error:
                self.close_connection = True
                self.send_json({"error": str(error)}, error.status)
            except (TimeoutError, ConnectionResetError, BrokenPipeError):
                self.close_connection = True
            except (OSError, sqlite3.Error):
                self.close_connection = True
                self.send_json({"error": "Het bestand kon niet worden opgeslagen. Probeer opnieuw."}, 503)
            finally:
                connection.close()
            return
        if path == "/api/chat/attachments":
            user = self.require_user()
            if not user:
                return
            if user not in MEMBERS:
                self.send_json({"error": "Deze chat is voor de twee ingestelde chataccounts."}, 403)
                return
            connection = db()
            try:
                self.connection.settimeout(180)
                item = chat_files.store_upload(connection, CHAT_UPLOAD_DIR, user, self.headers, self.rfile)
                self.send_json({"item": item}, 201)
            except ValueError as error:
                self.close_connection = True
                self.send_json({"error": str(error)}, 400)
            except (TimeoutError, ConnectionResetError, BrokenPipeError):
                self.close_connection = True
            except OSError:
                self.close_connection = True
                self.send_json({"error": "Het bestand kon niet worden opgeslagen. Probeer opnieuw."}, 503)
            finally:
                connection.close()
            return
        try:
            payload = self.read_json()
        except (ValueError, json.JSONDecodeError) as error:
            self.send_json({"error": str(error)}, 400)
            return
        if path == "/api/login":
            username = str(payload.get("username", "")).strip()[:80]
            password = str(payload.get("password", ""))
            remote = f"{self.client_address[0]}:{username.casefold()}"
            with LOGIN_LOCK:
                attempts = [stamp for stamp in LOGIN_ATTEMPTS.get(remote, []) if time.monotonic() - stamp < 900]
                if len(attempts) >= 8:
                    LOGIN_ATTEMPTS[remote] = attempts
                    self.send_json({"error": "Te veel pogingen. Probeer het over een kwartier opnieuw."}, 429)
                    return
                attempts.append(time.monotonic())
                LOGIN_ATTEMPTS[remote] = attempts
            connection = db()
            try:
                row = connection.execute("SELECT password_hash FROM users WHERE username=?", (username,)).fetchone()
                if not row or not check_password(password, row["password_hash"]):
                    self.send_json({"error": "Naam of wachtwoord klopt niet."}, 401)
                    return
                with LOGIN_LOCK:
                    LOGIN_ATTEMPTS.pop(remote, None)
                token = secrets.token_urlsafe(32)
                connection.execute("DELETE FROM sessions WHERE expires_at<=?", (int(time.time()),))
                connection.execute("INSERT INTO sessions(token_hash,username,expires_at) VALUES(?,?,?)", (hashlib.sha256(token.encode()).hexdigest(), username, int(time.time()) + SESSION_DAYS * 86400))
                connection.commit()
                secure = "; Secure" if self.headers.get("X-Forwarded-Proto", urlparse(self.headers.get("Origin", "")).scheme) == "https" else ""
                self.send_json({"authenticated": True, "username": username, "config": config.public_settings()}, headers={"Set-Cookie": f"family_session={token}; HttpOnly; SameSite=Strict; Path=/; Max-Age={SESSION_DAYS*86400}{secure}"})
            finally:
                connection.close()
            return
        user = self.require_user()
        if not user:
            return
        connection = db()
        try:
            if path == "/api/logout":
                token = self.cookie_token()
                if token:
                    connection.execute("DELETE FROM sessions WHERE token_hash=?", (hashlib.sha256(token.encode()).hexdigest(),))
                    connection.commit()
                self.send_json({"ok": True}, headers={"Set-Cookie": "family_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0"})
            elif path in ("/api/push/subscribe", "/api/push/unsubscribe"):
                if user not in MEMBERS:
                    self.send_json({"error": "Meldingen zijn voor de ingestelde chataccounts."}, 403)
                    return
                if not isinstance(payload, dict):
                    raise ValueError("Ongeldige meldingeninstelling.")
                if path.endswith("/unsubscribe"):
                    endpoint = payload.get("endpoint")
                    if not isinstance(endpoint, str):
                        raise ValueError("Ongeldig meldingenadres.")
                    connection.execute("DELETE FROM push_subscriptions WHERE endpoint=? AND username=?", (endpoint, user))
                    connection.commit()
                    self.send_json({"ok": True})
                else:
                    if not PUSH_SERVICE or not PUSH_SERVICE.public_key:
                        self.send_json({"error": "Meldingen zijn tijdelijk niet beschikbaar. Probeer later opnieuw."}, 503)
                        return
                    session_hash = hashlib.sha256(self.cookie_token().encode()).hexdigest()
                    subscription_id = push_notifications.subscribe(connection, user, session_hash, payload.get("subscription"))
                    self.send_json({"ok": True, "subscription_id": subscription_id})
            elif path.startswith("/api/nextcloud/"):
                self.nextcloud_action(user, path.removeprefix("/api/nextcloud/"), payload)
            elif path == "/api/chat/setup":
                if user != MEMBERS[0]:
                    self.send_json({"error": "Alleen het eerste chataccount kan het tweede instellen."}, 403)
                    return
                password = payload.get("password", "")
                if not isinstance(password, str) or not 12 <= len(password) <= 1024:
                    raise ValueError("Kies een wachtwoord van minimaal 12 en maximaal 1024 tekens.")
                password_hash = pbkdf2(password)
                connection.execute("BEGIN IMMEDIATE")
                if connection.execute("SELECT 1 FROM users WHERE username=?", (MEMBERS[1],)).fetchone():
                    self.send_json({"error": "Het tweede account bestaat al. Het wachtwoord is niet veranderd."}, 409)
                    return
                connection.execute("INSERT INTO users(username,password_hash) VALUES(?,?)", (MEMBERS[1], password_hash))
                connection.commit()
                self.send_json({"ok": True}, 201)
            elif path in ("/api/chat", "/api/chat/read"):
                if user not in MEMBERS:
                    self.send_json({"error": "Deze chat is voor de twee ingestelde chataccounts."}, 403)
                    return
                if path.endswith("/read"):
                    last_id = payload.get("last_id")
                    if not isinstance(last_id, int) or isinstance(last_id, bool) or last_id < 0:
                        raise ValueError("Ongeldige berichtpositie.")
                    peer = MEMBERS[1] if user == MEMBERS[0] else MEMBERS[0]
                    last_id = connection.execute("SELECT coalesce(max(id),0) FROM chat_messages WHERE username=? AND id<=?", (peer, last_id)).fetchone()[0]
                    connection.execute("INSERT INTO chat_reads(username,last_id) VALUES(?,?) ON CONFLICT(username) DO UPDATE SET last_id=max(chat_reads.last_id,excluded.last_id)", (user, last_id))
                    connection.commit()
                    self.send_json({"ok": True})
                else:
                    try:
                        message = chat_files.create_message(connection, CHAT_UPLOAD_DIR, user, payload, iso_now())
                    except chat_files.MessageConflict as error:
                        self.send_json({"error": str(error)}, 409)
                        return
                    self.send_json({"item": message}, 201)
            elif path == "/api/tasks":
                title = str(payload.get("title", "")).strip()[:240]
                list_key = str(payload.get("list", "today"))
                if not title or list_key not in ("today", "tomorrow", "future-log"):
                    self.send_json({"error": "Vul een titel in en kies een geldige lijst."}, 400)
                    return
                task_id = uuid.uuid4().hex
                due_date = task_due_date(payload.get("due_date"))
                assigned_to = payload.get("assigned_to")
                if assigned_to not in (None, *MEMBERS):
                    raise ValueError("Kies een van de ingestelde gezinsleden.")
                reminder_token = task_reminders.token_for(payload, due_date, assigned_to)
                connection.execute("INSERT INTO tasks(id,title,list_key,due_date,created_by,created_at,sort_order,assigned_to,reminder_token) VALUES(?,?,?,?,?,?,?,?,?)", (task_id, title, list_key, due_date, user, iso_now(), int(time.time()), assigned_to, reminder_token))
                connection.commit()
                self.send_json({"item": task_reminders.public_task(connection.execute("SELECT * FROM tasks WHERE id=?", (task_id,)).fetchone())}, 201)
            elif path == "/api/pages":
                title = str(payload.get("title", "Nieuwe pagina")).strip()[:160] or "Nieuwe pagina"
                connection.execute("BEGIN IMMEDIATE")
                parent_id = payload.get("parent_id")
                validate_parent(connection, parent_id)
                page_id = uuid.uuid4().hex
                sort_order = connection.execute("SELECT COALESCE(MAX(sort_order), -1)+1 FROM pages WHERE parent_id IS ? AND deleted_at IS NULL", (parent_id,)).fetchone()[0]
                connection.execute("INSERT INTO pages(id,title,body,updated_by,updated_at,parent_id,sort_order) VALUES(?,?,?,?,?,?,?)", (page_id, title, "", user, iso_now(), parent_id, sort_order))
                connection.commit()
                self.send_json({"page": rowdict(connection.execute("SELECT * FROM pages WHERE id=?", (page_id,)).fetchone())}, 201)
            elif path.startswith("/api/pages/") and path.endswith("/restore"):
                page_id = path.removeprefix("/api/pages/").removesuffix("/restore")
                connection.execute("BEGIN IMMEDIATE")
                page = connection.execute("SELECT * FROM pages WHERE id=? AND deleted_at IS NOT NULL", (page_id,)).fetchone()
                if not page:
                    self.send_json({"error": "Pagina staat niet in de prullenbak."}, 404)
                    return
                branch = connection.execute("SELECT id,parent_id FROM pages WHERE deleted_batch=?", (page["deleted_batch"],)).fetchall()
                ids = {row["id"] for row in branch}
                for row in branch:
                    if row["parent_id"] not in ids and row["parent_id"] is not None:
                        parent = connection.execute("SELECT 1 FROM pages WHERE id=? AND deleted_at IS NULL", (row["parent_id"],)).fetchone()
                        if not parent:
                            connection.execute("UPDATE pages SET parent_id=NULL WHERE id=?", (row["id"],))
                connection.execute("UPDATE pages SET deleted_at=NULL,deleted_batch=NULL,updated_by=?,updated_at=? WHERE deleted_batch=?", (user, iso_now(), page["deleted_batch"]))
                connection.commit()
                self.send_json({"ok": True, "restored_count": len(branch), "page_id": page_id})
            elif path.startswith("/api/pages/") and path.endswith("/comments"):
                page_id = path.removeprefix("/api/pages/").removesuffix("/comments")
                connection.execute("BEGIN IMMEDIATE")
                body = str(payload.get("body", "")).strip()[:4000]
                if not body or not connection.execute("SELECT 1 FROM pages WHERE id=? AND deleted_at IS NULL", (page_id,)).fetchone():
                    self.send_json({"error": "Reactie of pagina ontbreekt."}, 400)
                    return
                comment_id = uuid.uuid4().hex
                connection.execute("INSERT INTO comments(id,page_id,username,body,created_at) VALUES(?,?,?,?,?)", (comment_id, page_id, user, body, iso_now()))
                connection.commit()
                self.send_json({"ok": True}, 201)
            elif path.startswith("/api/pages/") and path.endswith("/files"):
                page_id = path.removeprefix("/api/pages/").removesuffix("/files")
                connection.execute("BEGIN IMMEDIATE")
                if not connection.execute("SELECT 1 FROM pages WHERE id=? AND deleted_at IS NULL", (page_id,)).fetchone():
                    self.send_json({"error": "Pagina niet gevonden."}, 404)
                    return
                filename = str(payload.get("filename", "bestand"))[:180]
                mime = str(payload.get("mediaType", "application/octet-stream"))[:120]
                data = base64.b64decode(str(payload.get("data", "")), validate=True)
                if len(data) > 8 * 1024 * 1024:
                    self.send_json({"error": "Een bestand mag maximaal 8 MB zijn."}, 413)
                    return
                file_id = uuid.uuid4().hex
                target = UPLOAD_DIR / file_id
                target.write_bytes(data)
                os.chmod(target, 0o600)
                connection.execute("INSERT INTO files(id,page_id,username,filename,media_type,size,created_at) VALUES(?,?,?,?,?,?,?)", (file_id, page_id, user, filename, mime, len(data), iso_now()))
                connection.commit()
                self.send_json({"ok": True}, 201)
            else:
                self.send_json({"error": "Niet gevonden."}, 404)
        except (ValueError, TypeError, base64.binascii.Error) as error:
            self.send_json({"error": str(error)}, 400)
        finally:
            connection.close()

    def do_PATCH(self):
        path = unquote(urlparse(self.path).path)
        if not self.check_origin():
            return
        if path.startswith("/dashboard/api/"):
            path = path.removeprefix("/dashboard")
        user = self.require_user()
        if not user:
            return
        try:
            payload = self.read_json()
        except (ValueError, json.JSONDecodeError) as error:
            self.send_json({"error": str(error)}, 400)
            return
        connection = db()
        try:
            if path.startswith("/api/tasks/"):
                task_id = path.removeprefix("/api/tasks/")
                connection.execute("BEGIN IMMEDIATE")
                task = connection.execute("SELECT * FROM tasks WHERE id=?", (task_id,)).fetchone()
                if not task:
                    self.send_json({"error": "Taak niet gevonden."}, 404)
                    return
                if task["done"] or ("revision" in payload and payload["revision"] != task["revision"]):
                    self.send_json({"error": "Deze taak is intussen aangepast of afgevinkt. Sluit het venster en open de taak opnieuw om de nieuwste versie te bewerken."}, 409)
                    return
                if payload.get("done") is True:
                    connection.execute("UPDATE tasks SET done=1,revision=revision+1 WHERE id=?", (task_id,))
                else:
                    title = str(payload.get("title", task["title"])).strip()[:240]
                    list_key = str(payload.get("list", task["list_key"]))
                    if not title or list_key not in ("today", "tomorrow", "future-log"):
                        self.send_json({"error": "Ongeldige taak."}, 400)
                        return
                    due_date = task_due_date(payload.get("due_date", task["due_date"]))
                    assigned_to = payload.get("assigned_to", task["assigned_to"])
                    if assigned_to not in (None, *MEMBERS):
                        raise ValueError("Kies een van de ingestelde gezinsleden.")
                    reminder_token = task_reminders.token_for(payload, due_date, assigned_to, task)
                    connection.execute("UPDATE tasks SET title=?,list_key=?,due_date=?,assigned_to=?,reminder_token=?,revision=revision+1 WHERE id=?", (title, list_key, due_date, assigned_to, reminder_token, task_id))
                connection.commit()
                self.send_json({"ok": True})
            elif path == "/api/pages/reorder":
                source_id, target_id = payload.get("source_id"), payload.get("target_id")
                placement = payload.get("placement")
                if not isinstance(source_id, str) or not isinstance(target_id, str) or source_id == target_id or placement not in ("before", "after"):
                    raise ValueError("Ongeldige paginavolgorde.")
                connection.execute("BEGIN IMMEDIATE")
                source = connection.execute("SELECT parent_id FROM pages WHERE id=? AND deleted_at IS NULL", (source_id,)).fetchone()
                target = connection.execute("SELECT parent_id FROM pages WHERE id=? AND deleted_at IS NULL", (target_id,)).fetchone()
                if not source or not target or source["parent_id"] != target["parent_id"]:
                    self.send_json({"error": "Deze pagina’s zijn intussen verplaatst of verwijderd. Vernieuw het menu."}, 409)
                    return
                siblings = [row["id"] for row in connection.execute("SELECT id FROM pages WHERE parent_id IS ? AND deleted_at IS NULL ORDER BY sort_order, title COLLATE NOCASE, id", (source["parent_id"],))]
                siblings.remove(source_id)
                siblings.insert(siblings.index(target_id) + (placement == "after"), source_id)
                connection.executemany("UPDATE pages SET sort_order=? WHERE id=?", enumerate(siblings))
                connection.commit()
                self.send_json({"ok": True})
            elif path.startswith("/api/pages/") and path.endswith("/checklist"):
                page_id = path.removeprefix("/api/pages/").removesuffix("/checklist")
                line_index = payload.get("line")
                checked = payload.get("checked")
                expected = payload.get("expected")
                if type(line_index) is not int or line_index < 0 or type(checked) is not bool or not isinstance(expected, str):
                    raise ValueError("Ongeldig checklist-item.")
                connection.execute("BEGIN IMMEDIATE")
                page = connection.execute("SELECT * FROM pages WHERE id=? AND deleted_at IS NULL", (page_id,)).fetchone()
                if not page:
                    self.send_json({"error": "Pagina niet gevonden."}, 404)
                    return
                lines = page["body"].splitlines(keepends=True)
                pattern = r"^(\s*(?:[-*]|\d+\.)\s+\[)([ xX])(\](?:[ \t][^\r\n]*)?)(\r?\n)?$"
                current = re.fullmatch(pattern, lines[line_index]) if line_index < len(lines) else None
                previous = re.fullmatch(pattern, expected)
                if not current or not previous or current[1] != previous[1] or current[3] != previous[3]:
                    self.send_json({"error": "Deze checklist is intussen aangepast. De pagina wordt opnieuw geladen; vink daarna het juiste item aan."}, 409)
                    return
                lines[line_index] = current[1] + ("x" if checked else " ") + current[3] + (current[4] or "")
                connection.execute("UPDATE pages SET body=?,updated_by=?,updated_at=? WHERE id=?", ("".join(lines), user, iso_now(), page_id))
                connection.commit()
                self.send_json({"page": rowdict(connection.execute("SELECT * FROM pages WHERE id=?", (page_id,)).fetchone())})
            elif path.startswith("/api/pages/"):
                page_id = path.removeprefix("/api/pages/")
                connection.execute("BEGIN IMMEDIATE")
                page = connection.execute("SELECT * FROM pages WHERE id=? AND deleted_at IS NULL", (page_id,)).fetchone()
                if not page:
                    self.send_json({"error": "Pagina niet gevonden."}, 404)
                    return
                if any(key in payload and payload[key] != page[field] for key, field in (("expected_body", "body"), ("expected_title", "title"))):
                    # An identical retry is safe after a lost successful response.
                    if payload.get("body") == page["body"] and payload.get("title") == page["title"]:
                        self.send_json({"ok": True})
                    else:
                        self.send_json({"error": "Deze pagina is ondertussen door iemand anders gewijzigd."}, 409)
                    return
                if "body" in payload and (not isinstance(payload["body"], str) or len(payload["body"]) > 100_000):
                    self.send_json({"error": "De pagina mag maximaal 100.000 tekens bevatten."}, 400)
                    return
                title = str(payload.get("title", page["title"])).strip()[:160] or "Zonder titel"
                body = str(payload.get("body", page["body"]))[:100_000]
                parent_id = payload.get("parent_id", page["parent_id"])
                validate_parent(connection, parent_id, page_id)
                connection.execute("UPDATE pages SET title=?,body=?,parent_id=?,updated_by=?,updated_at=? WHERE id=?", (title, body, parent_id, user, iso_now(), page_id))
                connection.commit()
                self.send_json({"ok": True})
            else:
                self.send_json({"error": "Niet gevonden."}, 404)
        except (ValueError, TypeError) as error:
            self.send_json({"error": str(error)}, 400)
        finally:
            connection.close()

    def do_DELETE(self):
        path = unquote(urlparse(self.path).path)
        if not self.check_origin():
            return
        if path.startswith("/dashboard/api/"):
            path = path.removeprefix("/dashboard")
        user = self.require_user()
        if not user:
            return
        connection = db()
        try:
            if path.startswith("/api/pages/"):
                connection.execute("BEGIN IMMEDIATE")
                page_id = path.removeprefix("/api/pages/")
                ids = active_branch(connection, page_id)
                if not ids:
                    self.send_json({"error": "Pagina niet gevonden."}, 404)
                    return
                batch = uuid.uuid4().hex
                timestamp = iso_now()
                connection.executemany("UPDATE pages SET deleted_at=?,deleted_batch=?,updated_by=?,updated_at=? WHERE id=?", [(timestamp, batch, user, timestamp, item) for item in ids])
                connection.commit()
                self.send_json({"ok": True, "deleted_count": len(ids)})
            elif path.startswith("/api/tasks/"):
                connection.execute("DELETE FROM tasks WHERE id=?", (path.removeprefix("/api/tasks/"),))
                connection.commit()
                self.send_json({"ok": True})
            else:
                self.send_json({"error": "Niet gevonden."}, 404)
        finally:
            connection.close()


def main():
    global PUSH_SERVICE
    parser = argparse.ArgumentParser(description="Thuis family dashboard")
    parser.add_argument("--add-user", metavar="NAME", help="Maak een gezinsaccount aan of wijzig het wachtwoord")
    parser.add_argument("--host", default="127.0.0.1", help="Bindadres; productie hoort achter een HTTPS reverse proxy")
    parser.add_argument("--port", type=int, default=8771)
    args = parser.parse_args()
    if args.add_user:
        add_user(args.add_user)
        return
    connection = db()
    users = connection.execute("SELECT count(*) FROM users").fetchone()[0]
    if CHAT_UPLOAD_DIR.is_dir():
        chat_files.cleanup(connection, CHAT_UPLOAD_DIR)
    connection.close()
    if users == 0:
        if args.host not in ("127.0.0.1", "::1"):
            raise SystemExit("Voltooi de eerste installatie eerst op 127.0.0.1.")
        print(f"Stel je gezin in: http://localhost:{args.port}/setup.html#token={SETUP_TOKEN}", flush=True)
    httpd = ThreadingHTTPServer((args.host, args.port), Handler)
    PUSH_SERVICE = push_notifications.PushService(PRIVATE_DIR, db)
    PUSH_SERVICE.start()
    print(f"Gezinsdashboard luistert op http://{args.host}:{args.port}/")
    httpd.serve_forever()


if __name__ == "__main__":
    main()
