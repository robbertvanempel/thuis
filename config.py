"""Installation-specific settings live outside the source checkout."""
import json
import os
from pathlib import Path
from urllib.parse import urlsplit

PRIVATE_DIR = Path(os.environ.get('FAMILY_DASHBOARD_DATA', Path.home() / '.thuis')).expanduser()
CONFIG_FILE = PRIVATE_DIR / 'config.json'
SETTINGS = json.loads(CONFIG_FILE.read_text()) if CONFIG_FILE.exists() else {}
MEMBERS = list(SETTINGS.get('members', ['Ouder 1', 'Ouder 2']))


def validate_members(names):
    if (not isinstance(names, list) or len(names) != 2
            or any(not isinstance(n, str) or not 1 <= len(n) <= 80 or n != n.strip()
                   or any(ord(c) < 32 for c in n) for n in names)
            or names[0].casefold() == names[1].casefold()):
        raise ValueError('Vul twee verschillende accountnamen in (maximaal 80 tekens).')


validate_members(MEMBERS)


def save_members(names):
    validate_members(names)
    PRIVATE_DIR.mkdir(mode=0o700, parents=True, exist_ok=True)
    value = {**SETTINGS, 'members': names}
    temporary = CONFIG_FILE.with_suffix('.tmp')
    with os.fdopen(os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), 'w') as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, CONFIG_FILE)
    SETTINGS.update(value)
    MEMBERS[:] = names


def public_settings():
    """Only safe UI fields, and only returned after authentication."""
    def links(key):
        return [{'title': str(item.get('title', 'Link'))[:160], 'url': item['url']}
                for item in SETTINGS.get(key, []) if isinstance(item, dict)
                and isinstance(item.get('url'), str)
                and urlsplit(item['url']).scheme == 'https'
                and urlsplit(item['url']).hostname
                and not urlsplit(item['url']).username]
    weather = SETTINGS.get('weather')
    if not (isinstance(weather, dict)
            and isinstance(weather.get('latitude'), (float, int))
            and isinstance(weather.get('longitude'), (float, int))
            and -90 <= weather['latitude'] <= 90 and -180 <= weather['longitude'] <= 180):
        weather = None
    return {'members': MEMBERS, 'weather': weather,
            'nextcloud_url': SETTINGS.get('nextcloud_url', ''),
            'photo_links': links('photo_links'), 'holiday_links': links('holiday_links')}
