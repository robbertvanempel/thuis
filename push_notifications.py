"""Opt-in Web Push for family chat; all keys and subscriptions stay private."""
from __future__ import annotations

from config import MEMBERS, SETTINGS

import base64
import json
import logging
import os
import re
import threading
import time
import uuid
import task_reminders
from pathlib import Path
from urllib.parse import urlparse

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec


def initialize(connection):
    connection.execute("""CREATE TABLE IF NOT EXISTS push_subscriptions (
        endpoint TEXT PRIMARY KEY, id TEXT NOT NULL UNIQUE,
        username TEXT NOT NULL REFERENCES users(username) ON DELETE CASCADE,
        session_hash TEXT NOT NULL REFERENCES sessions(token_hash) ON DELETE CASCADE,
        subscription TEXT NOT NULL, last_id INTEGER NOT NULL DEFAULT 0,
        attempts INTEGER NOT NULL DEFAULT 0, retry_at INTEGER NOT NULL DEFAULT 0
    )""")


def validate_subscription(value):
    if not isinstance(value, dict):
        raise ValueError("Ongeldige meldingeninstelling.")
    endpoint = value.get("endpoint")
    if not isinstance(endpoint, str) or len(endpoint) > 4096:
        raise ValueError("Ongeldig meldingenadres.")
    url = urlparse(endpoint)
    # Only browser push providers may receive outgoing requests, never arbitrary URLs.
    providers = {"fcm.googleapis.com", "updates.push.services.mozilla.com", "web.push.apple.com"}
    if (url.scheme != "https" or url.hostname not in providers or url.port not in (None, 443)
            or url.username or url.password or url.fragment or not url.path.startswith("/")):
        raise ValueError("Deze browser ondersteunt de meldingen nog niet. Gebruik Chrome op Android.")
    keys = value.get("keys")
    if not isinstance(keys, dict):
        raise ValueError("De meldingssleutels ontbreken.")
    decoded = {}
    for name, size in (("p256dh", 65), ("auth", 16)):
        encoded = keys.get(name)
        if not isinstance(encoded, str) or not re.fullmatch(r"[A-Za-z0-9_-]{20,90}={0,2}", encoded):
            raise ValueError("Ongeldige meldingssleutel.")
        decoded[name] = base64.urlsafe_b64decode(encoded + "=" * (-len(encoded) % 4))
        if len(decoded[name]) != size:
            raise ValueError("Ongeldige meldingssleutel.")
    ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), decoded["p256dh"])
    return {"endpoint": endpoint, "keys": {name: keys[name] for name in ("p256dh", "auth")}}


def subscribe(connection, user, session_hash, value):
    subscription = validate_subscription(value)
    connection.execute("BEGIN IMMEDIATE")
    endpoint = subscription["endpoint"]
    existing = connection.execute("SELECT * FROM push_subscriptions WHERE endpoint=?", (endpoint,)).fetchone()
    peer = MEMBERS[1] if user == MEMBERS[0] else MEMBERS[0]
    latest = connection.execute("SELECT coalesce(max(id),0) FROM chat_messages WHERE username=?", (peer,)).fetchone()[0]
    # Reopening the same device preserves delivery progress; changing accounts rotates its id.
    same_account = existing and existing["username"] == user
    subscription_id = existing["id"] if same_account else uuid.uuid4().hex
    last_id = existing["last_id"] if same_account else latest
    if not existing and connection.execute("SELECT count(*) FROM push_subscriptions WHERE username=?", (user,)).fetchone()[0] >= 20:
        raise ValueError("Er zijn al twintig toestellen gekoppeld voor meldingen.")
    connection.execute("""INSERT INTO push_subscriptions(endpoint,id,username,session_hash,subscription,last_id)
        VALUES(?,?,?,?,?,?) ON CONFLICT(endpoint) DO UPDATE SET id=excluded.id,
        username=excluded.username,session_hash=excluded.session_hash,subscription=excluded.subscription,
        last_id=excluded.last_id,attempts=0,retry_at=0""",
        (endpoint, subscription_id, user, session_hash, json.dumps(subscription), last_id))
    connection.commit()
    return subscription_id


class PushService:
    def __init__(self, private_dir: Path, db_factory):
        self.db = db_factory
        self.public_key = None
        self.key_file = private_dir / "push-vapid.pem"
        if not SETTINGS.get("push_contact"):
            return
        try:
            from pywebpush import webpush
            import requests
            self.webpush = webpush
            # Never follow a push provider redirect to an unvalidated address.
            class PushSession(requests.Session):
                def request(self, *args, **kwargs):
                    kwargs["allow_redirects"] = False
                    return super().request(*args, **kwargs)
            self.http = PushSession()
            self.http.trust_env = False
            if not self.key_file.exists():
                private_key = ec.generate_private_key(ec.SECP256R1())
                pem = private_key.private_bytes(serialization.Encoding.PEM,
                    serialization.PrivateFormat.PKCS8, serialization.NoEncryption())
                with os.fdopen(os.open(self.key_file, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "wb") as handle:
                    handle.write(pem)
            os.chmod(self.key_file, 0o600)
            private_key = serialization.load_pem_private_key(self.key_file.read_bytes(), password=None)
            public_bytes = private_key.public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
            self.public_key = base64.urlsafe_b64encode(public_bytes).rstrip(b"=").decode()
        except Exception:
            logging.error("Web Push unavailable; chat remains available. Check private key and requirements-push.txt.")

    def start(self):
        if self.public_key:
            threading.Thread(target=self.run, name="family-chat-push", daemon=True).start()

    def run(self):
        while True:
            try:
                self.deliver_pending()
            except Exception:
                # Do not log endpoints, subscription keys or message contents.
                logging.warning("Chat notification delivery delayed; retrying.")
            try:
                task_reminders.deliver_pending(self)
            except Exception:
                logging.warning("Task reminder delivery delayed; retrying.")
            time.sleep(5)

    def deliver_pending(self):
        connection = self.db()
        try:
            now = int(time.time())
            connection.execute("DELETE FROM push_subscriptions WHERE session_hash NOT IN (SELECT token_hash FROM sessions WHERE expires_at>?)", (now,))
            rows = connection.execute("SELECT * FROM push_subscriptions WHERE retry_at<=?", (now,)).fetchall()
            connection.commit()
        finally:
            connection.close()
        for row in rows:
            self.deliver(row)

    def deliver(self, row):
        connection = self.db()
        try:
            # Recheck after waiting for a different device: it may have logged out.
            active = connection.execute("SELECT 1 FROM push_subscriptions p JOIN sessions s ON s.token_hash=p.session_hash WHERE p.id=? AND s.expires_at>?", (row["id"], int(time.time()))).fetchone()
            if not active:
                return
            peer = MEMBERS[1] if row["username"] == MEMBERS[0] else MEMBERS[0]
            latest, unread = connection.execute("""SELECT coalesce(max(id),0),count(*) FROM chat_messages
                WHERE username=? AND id>coalesce((SELECT last_id FROM chat_reads WHERE username=?),0)""", (peer, row["username"])).fetchone()
            if not unread or latest <= row["last_id"]:
                return
            message = connection.execute("SELECT body FROM chat_messages WHERE id=? AND username=?", (latest, peer)).fetchone()
            preview = " ".join(message["body"].split()) if message else ""
            if not preview:
                files = connection.execute("SELECT filename FROM chat_attachments WHERE message_id=? ORDER BY created_at,id", (latest,)).fetchall()
                if files:
                    preview = f"📎 {files[0]['filename']}" if len(files) == 1 else f"📎 {len(files)} bestanden"
            if len(preview) > 160:
                preview = preview[:159].rstrip() + "…"
        finally:
            connection.close()
        status = 0
        try:
            response = self.webpush(subscription_info=json.loads(row["subscription"]),
                data=json.dumps({"subscription_id": row["id"], "unread": unread,
                    "sender": peer, "preview": preview}, ensure_ascii=False),
                vapid_private_key=str(self.key_file), vapid_claims={"sub": SETTINGS.get("push_contact", "https://example.com")},
                ttl=3600, headers={"Urgency": "high", "Topic": "thuis-chat"},
                timeout=10, requests_session=self.http)
            status = response.status_code
        except Exception as error:
            response = getattr(error, "response", None)
            status = response.status_code if response is not None else 0
        connection = self.db()
        try:
            if status in (404, 410):
                connection.execute("DELETE FROM push_subscriptions WHERE id=?", (row["id"],))
            elif 200 <= status < 300:
                connection.execute("UPDATE push_subscriptions SET last_id=max(last_id,?),attempts=0,retry_at=0 WHERE id=?", (latest, row["id"]))
            else:
                attempts = min(row["attempts"] + 1, 8)
                connection.execute("UPDATE push_subscriptions SET attempts=?,retry_at=? WHERE id=?", (attempts, int(time.time()) + min(3600, 15 * 2 ** attempts), row["id"]))
                logging.warning("Chat push provider temporarily unavailable (HTTP %s); retry scheduled.", status)
            connection.commit()
        finally:
            connection.close()
