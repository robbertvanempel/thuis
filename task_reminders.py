"""Task dates and opt-in reminders, using the existing private Web Push service."""
from __future__ import annotations

from config import MEMBERS, SETTINGS

import json
import logging
import time
import uuid
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

TZ = ZoneInfo("Europe/Amsterdam")


def initialize(connection):
    columns = {row["name"] for row in connection.execute("PRAGMA table_info(tasks)")}
    for name, definition in (("revision", "INTEGER NOT NULL DEFAULT 0"), ("reminder_token", "TEXT")):
        if name not in columns:
            connection.execute(f"ALTER TABLE tasks ADD COLUMN {name} {definition}")
    # A null token leaves all pre-existing dates inactive until explicitly saved.
    connection.execute("""CREATE TABLE IF NOT EXISTS task_reminder_deliveries (
        subscription_id TEXT NOT NULL REFERENCES push_subscriptions(id) ON DELETE CASCADE ON UPDATE CASCADE,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        reminder_token TEXT NOT NULL, delivered_at INTEGER NOT NULL DEFAULT 0,
        attempts INTEGER NOT NULL DEFAULT 0, retry_at INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(subscription_id,task_id)
    )""")


def recipient(task):
    return task["assigned_to"] or task["created_by"]


def token_for(payload, due_date, assigned_to, previous=None):
    enabled = payload.get("reminder_enabled", bool(previous and previous["reminder_token"]))
    if not isinstance(enabled, bool):
        raise ValueError("Ongeldige herinneringskeuze.")
    if not due_date or not enabled:
        return None
    if (previous and previous["reminder_token"] and due_date == previous["due_date"]
            and assigned_to == previous["assigned_to"]):
        return previous["reminder_token"]
    if due_date < datetime.now(TZ).date().isoformat():
        if previous and previous["reminder_token"] and due_date == previous["due_date"]:
            return previous["reminder_token"]
        raise ValueError("Kies vandaag of een toekomstige dag voor de herinnering.")
    return uuid.uuid4().hex


def public_task(task):
    result = dict(task)
    result["reminder_enabled"] = bool(result.pop("reminder_token", None))
    return result


def available(task, username, now=None):
    now = now or datetime.now(TZ)
    return bool(task and not task["done"] and task["reminder_token"]
                and recipient(task) == username and now.hour >= 9
                and task["due_date"] == now.date().isoformat())


def deliver_pending(service):
    now = datetime.now(TZ)
    if now.hour < 9:
        return
    connection = service.db()
    try:
        rows = connection.execute("""SELECT p.id AS subscription_id,t.id AS task_id
            FROM tasks t JOIN push_subscriptions p ON p.username=coalesce(t.assigned_to,t.created_by)
            JOIN sessions s ON s.token_hash=p.session_hash AND s.expires_at>?
            LEFT JOIN task_reminder_deliveries d ON d.subscription_id=p.id AND d.task_id=t.id
            WHERE t.done=0 AND t.due_date=? AND t.reminder_token IS NOT NULL
              AND (d.reminder_token IS NULL OR d.reminder_token!=t.reminder_token
                   OR (d.delivered_at=0 AND d.retry_at<=?))
            ORDER BY t.sort_order,t.id LIMIT 100""",
            (int(time.time()), now.date().isoformat(), int(time.time()))).fetchall()
    finally:
        connection.close()
    for row in rows:
        deliver(service, row["subscription_id"], row["task_id"])


def deliver(service, subscription_id, task_id):
    connection = service.db()
    try:
        subscription = connection.execute("""SELECT p.* FROM push_subscriptions p
            JOIN sessions s ON s.token_hash=p.session_hash
            WHERE p.id=? AND s.expires_at>?""", (subscription_id, int(time.time()))).fetchone()
        task = connection.execute("SELECT * FROM tasks WHERE id=?", (task_id,)).fetchone()
        now = datetime.now(TZ)
        if not subscription or not available(task, subscription["username"], now):
            return
        previous = connection.execute("SELECT * FROM task_reminder_deliveries WHERE subscription_id=? AND task_id=?",
                                      (subscription_id, task_id)).fetchone()
        same = previous and previous["reminder_token"] == task["reminder_token"]
        if same and (previous["delivered_at"] or previous["retry_at"] > int(time.time())):
            return
        attempts = previous["attempts"] if same else 0
        expires = int((now + timedelta(days=1)).replace(hour=0, minute=0, second=0, microsecond=0).timestamp())
        payload = {"kind": "task", "subscription_id": subscription_id, "task_id": task_id,
                   "reminder_token": task["reminder_token"], "preview": task["title"], "expires_at": expires}
    finally:
        connection.close()
    status = 0
    try:
        response = service.webpush(subscription_info=json.loads(subscription["subscription"]),
            data=json.dumps(payload, ensure_ascii=False), vapid_private_key=str(service.key_file),
            vapid_claims={"sub": SETTINGS.get("push_contact", "https://example.com")}, ttl=max(1, min(3600, expires - int(time.time()))),
            headers={"Urgency": "high", "Topic": task_id}, timeout=10, requests_session=service.http)
        status = response.status_code
    except Exception as error:
        response = getattr(error, "response", None)
        status = response.status_code if response is not None else 0
    connection = service.db()
    try:
        if status in (404, 410):
            connection.execute("DELETE FROM push_subscriptions WHERE id=?", (subscription_id,))
        else:
            success = 200 <= status < 300
            attempts = min(attempts + 1, 8)
            # Only record a result if both records still exist after the provider call.
            connection.execute("""INSERT INTO task_reminder_deliveries
                (subscription_id,task_id,reminder_token,delivered_at,attempts,retry_at)
                SELECT ?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM push_subscriptions WHERE id=?)
                    AND EXISTS(SELECT 1 FROM tasks WHERE id=? AND reminder_token=?)
                ON CONFLICT(subscription_id,task_id) DO UPDATE SET
                    reminder_token=excluded.reminder_token,delivered_at=excluded.delivered_at,
                    attempts=excluded.attempts,retry_at=excluded.retry_at""",
                (subscription_id, task_id, task["reminder_token"], int(time.time()) if success else 0,
                 0 if success else attempts, 0 if success else int(time.time()) + min(3600, 15 * 2 ** attempts),
                 subscription_id, task_id, task["reminder_token"]))
            if not success:
                logging.warning("Task push provider temporarily unavailable (HTTP %s); retry scheduled.", status)
        connection.commit()
    finally:
        connection.close()
