"""Two independent sessions must never acknowledge their own messages."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import secrets
import sys
import tempfile
import threading
import time
import unittest
import urllib.request
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


class ChatReceiptTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        with patch.dict(os.environ, {'FAMILY_DASHBOARD_DATA': cls.temp.name,
                                    'FAMILY_DASHBOARD_ORIGINS': 'https://family.test'}):
            spec = importlib.util.spec_from_file_location('family_chat_tests', ROOT / 'server.py')
            cls.app = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(cls.app)
        cls.cookies = {}
        with cls.app.db() as connection:
            for user in ('Ouder 1', 'Ouder 2'):
                token = secrets.token_urlsafe(24)
                cls.cookies[user] = 'family_session=' + token
                connection.execute('INSERT INTO users VALUES (?,?)', (user, 'unused-test-hash'))
                connection.execute('INSERT INTO sessions VALUES (?,?,?)',
                                   (hashlib.sha256(token.encode()).hexdigest(), user, int(time.time()) + 600))
        connection.close()
        cls.httpd = cls.app.ThreadingHTTPServer(('127.0.0.1', 0), cls.app.Handler)
        cls.thread = threading.Thread(target=cls.httpd.serve_forever, daemon=True)
        cls.thread.start()
        cls.base = 'http://127.0.0.1:' + str(cls.httpd.server_port)

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        cls.thread.join()
        cls.temp.cleanup()

    def request(self, user, method, path, data=None):
        request = urllib.request.Request(self.base + path, method=method,
            data=json.dumps(data).encode() if data is not None else None,
            headers={'Origin': 'https://family.test', 'Content-Type': 'application/json',
                     'Cookie': self.cookies[user]})
        with urllib.request.urlopen(request) as response:
            return json.load(response)

    def send(self, user):
        return self.request(user, 'POST', '/api/chat',
                            {'body': 'Isolated test message', 'client_id': secrets.token_hex(16)})['item']['id']

    def test_only_the_recipient_can_set_the_senders_read_receipt(self):
        for sender, recipient in [('Ouder 1', 'Ouder 2'), ('Ouder 2', 'Ouder 1')]:
            with self.subTest(sender=sender):
                with self.app.db() as connection:
                    connection.execute('DELETE FROM chat_reads')
                    connection.execute('DELETE FROM chat_messages')
                connection.close()
                sent = self.send(sender)
                self.request(sender, 'POST', '/api/chat/read', {'last_id': sent, 'username': recipient})
                before = self.request(sender, 'GET', '/api/chat')
                self.assertEqual(before['peer'], recipient)
                self.assertEqual(before['peer_read'], 0)
                self.assertEqual(self.request(recipient, 'GET', '/api/chat')['unread'], 1)

                self.request(recipient, 'POST', '/api/chat/read', {'last_id': sent})
                self.assertEqual(self.request(sender, 'GET', '/api/chat')['peer_read'], sent)
                self.assertEqual(self.request(recipient, 'GET', '/api/chat')['unread'], 0)

                reply = self.send(recipient)
                self.request(recipient, 'POST', '/api/chat/read', {'last_id': reply})
                self.assertEqual(self.request(sender, 'GET', '/api/chat')['peer_read'], sent)
                self.assertEqual(self.request(sender, 'GET', '/api/chat')['unread'], 1)

                self.request(sender, 'POST', '/api/chat/read', {'last_id': reply})
                self.assertEqual(self.request(recipient, 'GET', '/api/chat')['peer_read'], reply)
                later = self.send(sender)
                self.assertLess(self.request(sender, 'GET', '/api/chat')['peer_read'], later)


if __name__ == '__main__':
    unittest.main()
