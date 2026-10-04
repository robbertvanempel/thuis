"""Read only calendars explicitly configured by this installation's owner."""
from datetime import datetime, timedelta, time
from urllib.request import Request, urlopen
from urllib.parse import urlsplit
from zoneinfo import ZoneInfo
from icalendar import Calendar
import recurring_ical_events

TZ = ZoneInfo('Europe/Amsterdam')


def read_calendar(settings, private_dir):
    now = datetime.now(TZ)
    start = datetime.combine(now.date(), time.min, tzinfo=TZ)
    end = start + timedelta(days=7)
    result = {'status': 'unavailable', 'detail': 'Voeg je eigen agenda toe in config.json.',
              'items': [], 'time_zone': TZ.key, 'today': start.date().isoformat(),
              'range_end': end.date().isoformat(), 'server_now': now.isoformat()}
    calendars = settings.get('calendars', [])
    if not calendars:
        return result
    try:
        for calendar in calendars:
            if 'file' in calendar:
                path = (private_dir / calendar['file']).resolve()
                if not path.is_relative_to(private_dir.resolve()):
                    raise ValueError('Calendar file must be inside private data directory')
                with path.open('rb') as stream:
                    content = stream.read(5_000_001)
            else:
                url = calendar['url']
                parsed = urlsplit(url)
                if parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password:
                    raise ValueError('HTTPS calendar URL required')
                with urlopen(Request(url, headers={'User-Agent': 'Thuis/1.0'}), timeout=12) as response:
                    if urlsplit(response.url).scheme != 'https':
                        raise ValueError('HTTPS required')
                    content = response.read(5_000_001)
            if len(content) > 5_000_000:
                raise ValueError('Calendar too large')
            events = recurring_ical_events.of(Calendar.from_ical(content)).between(start, end)
            for event in events:
                if str(event.get('STATUS', '')).upper() == 'CANCELLED':
                    continue
                value = event.decoded('DTSTART')
                all_day = not isinstance(value, datetime)
                stamp = datetime.combine(value, time.min, tzinfo=TZ) if all_day else (value.replace(tzinfo=TZ) if value.tzinfo is None else value.astimezone(TZ))
                if not start <= stamp < end:
                    continue
                result['items'].append({'title': str(event.get('SUMMARY', 'Afspraak')),
                    'start': stamp.isoformat(), 'date': stamp.date().isoformat(),
                    'time': 'Hele dag' if all_day else stamp.strftime('%H:%M'),
                    'calendar': str(calendar.get('name', 'Agenda')),
                    'category': calendar.get('category', 'family'),
                    'location': ' '.join(str(event.get('LOCATION', '')).split())[:90]})
        result['items'].sort(key=lambda item: item['start'])
        result.update(status='connected', detail=f"{len(result['items'])} afspraken uit {len(calendars)} agenda's.")
    except Exception:
        # Never expose secret calendar URLs or event content through diagnostics.
        result.update(status='error', detail='De agenda is tijdelijk niet bereikbaar.', items=[])
    return result
