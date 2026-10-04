#!/usr/bin/env python3
"""Start the local server and open its actual first-run or login screen."""
import argparse
import json
import os
from pathlib import Path
import socket
import sqlite3
import subprocess
import sys
import time
import urllib.request
import webbrowser

ROOT = Path(__file__).resolve().parent


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--background', action='store_true')
    parser.add_argument('--no-browser', action='store_true')
    parser.add_argument('--port', type=int, default=8771)
    args = parser.parse_args()
    private = Path(os.environ.get('FAMILY_DASHBOARD_DATA', Path.home() / '.thuis')).expanduser()
    private.mkdir(mode=0o700, parents=True, exist_ok=True)
    state_path = private / 'local-server.json'
    url = f'http://localhost:{args.port}/'
    command = [sys.executable, str(ROOT / 'server.py'), '--port', str(args.port)]
    if not args.background:
        return subprocess.call(command)
    with socket.socket() as check:
        occupied = check.connect_ex(('127.0.0.1', args.port)) == 0
    if occupied:
        try:
            state = json.loads(state_path.read_text())
            with urllib.request.urlopen(url + 'api/health', timeout=2) as response:
                health = json.load(response)
            if state['port'] != args.port or state['instance'] != health.get('instance'):
                raise ValueError()
        except Exception:
            raise SystemExit('Deze poort is al in gebruik door een andere installatie. Kies --port met een vrije poort.')
    else:
        import secrets
        instance = secrets.token_urlsafe(24)
        environment = {**os.environ, 'THUIS_INSTANCE': instance, 'PYTHONUNBUFFERED': '1'}
        log_path = private / 'server.log'
        with os.fdopen(os.open(log_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), 'w') as log:
            kwargs = {'creationflags': subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP} if os.name == 'nt' else {'start_new_session': True}
            process = subprocess.Popen(command, cwd=ROOT, env=environment, stdin=subprocess.DEVNULL, stdout=log, stderr=log, **kwargs)
        for _ in range(100):
            if process.poll() is not None:
                raise SystemExit(f'Starten mislukt. Bekijk het lokale logbestand {log_path}.')
            try:
                with urllib.request.urlopen(url + 'api/health', timeout=.5) as response:
                    health = json.load(response)
                if health.get('instance') == instance:
                    break
            except OSError:
                pass
            time.sleep(.1)
        else:
            process.terminate()
            raise SystemExit(f'De server is niet tijdig gestart. Bekijk {log_path}.')
        state = {'port': args.port, 'pid': process.pid, 'instance': instance}
        with os.fdopen(os.open(state_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), 'w') as stream:
            json.dump(state, stream)
    # The one-time setup link stays in a mode-0600 log, outside the repository.
    with sqlite3.connect(private / 'family-dashboard.sqlite3') as connection:
        needs_setup = connection.execute('SELECT count(*) FROM users').fetchone()[0] == 0
    if needs_setup:
        for line in (private / 'server.log').read_text().splitlines():
            if line.startswith('Stel je gezin in: '):
                url = line.removeprefix('Stel je gezin in: ')
                break
    print(f'Thuis draait: {url}\nStart na een herstart opnieuw met je Start Thuis-snelkoppeling.')
    if not args.no_browser:
        webbrowser.open(url)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
