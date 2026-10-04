"""A fresh real server must start empty and accept only a one-time local setup."""
import json
import os
from pathlib import Path
import socket
import sqlite3
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[1]


class PublicInstallTests(unittest.TestCase):
    def test_empty_setup_arbitrary_accounts_and_restart(self):
        with tempfile.TemporaryDirectory() as folder:
            private = Path(folder)
            with socket.socket() as sock:
                sock.bind(('127.0.0.1', 0)); port = sock.getsockname()[1]
            base = f'http://localhost:{port}'
            environment = {**os.environ, 'FAMILY_DASHBOARD_DATA': folder, 'FAMILY_DASHBOARD_ORIGINS': '', 'PYTHONUNBUFFERED': '1'}
            def request(path, data=None, cookie='', origin=base):
                headers = {'Origin': origin, 'Content-Type': 'application/json', 'Cookie': cookie}
                req = urllib.request.Request(base+path, data=json.dumps(data).encode() if data is not None else None, headers=headers)
                try: response = urllib.request.urlopen(req, timeout=5)
                except urllib.error.HTTPError as error: response = error
                with response:
                    body = response.read()
                    return response.status, json.loads(body) if 'json' in response.headers.get('Content-Type','') else body, response.headers
            log = (private / 'test.log').open('w+')
            def start():
                process = subprocess.Popen([sys.executable, str(ROOT/'server.py'), '--port', str(port)], env=environment, stdout=log, stderr=log)
                for _ in range(100):
                    try:
                        if request('/api/health')[0] == 200: return process
                    except OSError: pass
                    if process.poll() is not None:
                        log.seek(0); self.fail(log.read())
                    time.sleep(.05)
                process.terminate(); process.wait(); self.fail('Server did not start')
            process = start()
            try:
                log.flush(); log.seek(0)
                token = log.read().split('#token=')[1].splitlines()[0]
                connection = sqlite3.connect(private/'family-dashboard.sqlite3')
                for table in ['users','tasks','pages','chat_messages','comments','files']:
                    self.assertEqual(connection.execute(f'SELECT count(*) FROM {table}').fetchone()[0], 0)
                connection.close()
                self.assertEqual(request('/api/pages')[0], 401)
                names = ['Alex & Co', 'Noor 🌿']
                payload = {'token':token,'members':names,'passwords':['Synthetic-test-pass-1','Synthetic-test-pass-2']}
                self.assertEqual(request('/api/setup',{**payload,'token':'invalid'})[0],403)
                self.assertEqual(request('/api/setup',payload,origin='https://untrusted.example')[0],403)
                self.assertEqual(request('/api/setup',payload)[0],201)
                self.assertEqual(request('/api/setup',payload)[0],409)
                status, data, headers = request('/api/login',{'username':names[0],'password':payload['passwords'][0]})
                self.assertEqual(status,200); self.assertEqual(data['config']['members'],names)
                cookie = headers['Set-Cookie'].split(';')[0]
                self.assertEqual(request('/api/pages',cookie=cookie)[1]['items'],[])
                self.assertEqual(request('/api/chat',cookie=cookie)[1]['peer'],names[1])
                self.assertEqual(request('/api/chat',cookie=cookie)[1]['items'],[])
                self.assertEqual(request('/api/agenda',cookie=cookie)[1]['status'],'unavailable')
                self.assertFalse(request('/api/push/config',cookie=cookie)[1]['available'])
                self.assertEqual(request('/config.json',cookie=cookie)[0],404)
                self.assertEqual(request('/server.py',cookie=cookie)[0],404)
                status, _, _ = request('/api/tasks', {'title':'Synthetic task','list_key':'today','assigned_to':names[1]},cookie)
                self.assertEqual(status,201)
                task = request('/api/tasks',cookie=cookie)[1]['items'][0]
                self.assertEqual(task['assigned_to'],names[1])
                process.terminate(); process.wait(timeout=5); process = start()
                self.assertEqual(request('/api/me',cookie=cookie)[1]['config']['members'],names)
                self.assertEqual(request('/api/tasks',cookie=cookie)[1]['items'][0]['title'],'Synthetic task')
                self.assertEqual(request('/api/chat',cookie=cookie)[1]['peer'],names[1])
            finally:
                process.terminate(); process.wait(timeout=5); log.close()


if __name__ == '__main__': unittest.main()
