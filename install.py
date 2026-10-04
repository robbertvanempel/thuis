#!/usr/bin/env python3
"""Install Thuis locally without copying any household data."""
import argparse
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import sys
import venv

ROOT = Path(__file__).resolve().parent


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--no-start', action='store_true', help='Install only; do not start the server or browser')
    parser.add_argument('--mac-app', action='store_true', help='Also build and install the native Mac client (requires Xcode Command Line Tools)')
    args = parser.parse_args()
    if sys.version_info < (3, 11):
        raise SystemExit('Python 3.11 of nieuwer is nodig. Installeer Python via https://www.python.org/downloads/.')
    environment = ROOT / '.venv'
    python = environment / ('Scripts/python.exe' if os.name == 'nt' else 'bin/python')
    if not python.exists():
        venv.EnvBuilder(with_pip=True).create(environment)
    subprocess.run([str(python), '-m', 'pip', 'install', '-r', str(ROOT / 'requirements-lock.txt')], check=True)
    launcher = ROOT / ('Start Thuis.cmd' if os.name == 'nt' else 'Start Thuis.command')
    if os.name == 'nt':
        launcher.write_text('@echo off\r\n"' + str(python) + '" "' + str(ROOT / 'run.py') + '" --background\r\npause\r\n')
    else:
        launcher.write_text('#!/bin/sh\nexec ' + shlex.quote(str(python)) + ' ' + shlex.quote(str(ROOT / 'run.py')) + ' --background\n')
        launcher.chmod(0o755)
    if args.mac_app:
        if sys.platform != 'darwin':
            raise SystemExit('--mac-app werkt alleen op macOS.')
        destination = Path.home() / 'Applications' / 'Thuis.app'
        if destination.exists():
            raise SystemExit(f'Bestaande app blijft behouden: {destination}. De webapp is geïnstalleerd. Verplaats de bestaande app zelf voor je opnieuw --mac-app gebruikt.')
        subprocess.run(['bash', str(ROOT / 'macos/build.sh')], check=True)
        destination.parent.mkdir(exist_ok=True)
        shutil.copytree(ROOT / 'macos/build/Thuis.app', destination)
    print(f'Geïnstalleerd in {ROOT}\nStarten: {launcher}\nPrivégegevens: FAMILY_DASHBOARD_DATA of standaard ~/.thuis')
    if not args.no_start:
        subprocess.run([str(python), str(ROOT / 'run.py'), '--background'], check=True)


if __name__ == '__main__':
    main()
