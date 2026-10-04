"""Standalone calendar integration must use only explicit configuration."""
from datetime import datetime
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch
from zoneinfo import ZoneInfo
from calendar_feed import read_calendar


class CalendarFeedTests(unittest.TestCase):
    def test_disabled_calendar_makes_no_network_request(self):
        with patch('calendar_feed.urlopen') as request:
            self.assertEqual(read_calendar({},Path('.'))['status'],'unavailable')
            request.assert_not_called()

    def test_local_icalendar_expands_recurring_events(self):
        today = datetime.now(ZoneInfo('Europe/Amsterdam')).strftime('%Y%m%d')
        ics = f'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Thuis test//EN\r\nBEGIN:VEVENT\r\nUID:synthetic-test-event\r\nDTSTART;VALUE=DATE:{today}\r\nRRULE:FREQ=DAILY;COUNT=3\r\nSUMMARY:Synthetic appointment\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n'
        with TemporaryDirectory() as folder:
            private=Path(folder); (private/'test.ics').write_bytes(ics.encode('utf-8'))
            result=read_calendar({'calendars':[{'file':'test.ics','name':'Test'}]},private)
            self.assertEqual(result['status'],'connected')
            self.assertEqual(len(result['items']),3)
            self.assertTrue(all(item['time']=='Hele dag' for item in result['items']))
            error=read_calendar({'calendars':[{'file':'../outside.ics'}]},private)
            self.assertEqual(error['status'],'error')
