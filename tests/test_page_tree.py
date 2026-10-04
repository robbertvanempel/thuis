"""Real HTTP + SQLite regression checks for page hierarchy and recoverable deletion."""
import base64
import concurrent.futures
import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import tempfile
import threading
import unittest
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[1]


class PageTreeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        os.environ['FAMILY_DASHBOARD_DATA'] = cls.temp.name
        os.environ['FAMILY_DASHBOARD_ORIGINS'] = 'https://family.test'
        old = sqlite3.connect(Path(cls.temp.name) / 'family-dashboard.sqlite3')
        old.execute("CREATE TABLE pages (id TEXT PRIMARY KEY,title TEXT NOT NULL,body TEXT NOT NULL DEFAULT '',updated_by TEXT NOT NULL,updated_at TEXT NOT NULL)")
        old.execute("INSERT INTO pages VALUES ('legacy','Bestaand','Bestaande inhoud','Ouder 1','2026-09-28')")
        old.commit(); old.close()
        spec = importlib.util.spec_from_file_location('family_tree_tests', ROOT / 'server.py')
        cls.app = importlib.util.module_from_spec(spec); spec.loader.exec_module(cls.app)
        with cls.app.db() as db:
            db.execute('INSERT INTO users VALUES (?,?)', ('TreeCheck', cls.app.pbkdf2('Temporary-page-tree-test')))
        db.close()
        cls.httpd = cls.app.ThreadingHTTPServer(('127.0.0.1', 0), cls.app.Handler)
        cls.thread = threading.Thread(target=cls.httpd.serve_forever, daemon=True); cls.thread.start()
        cls.base = 'http://127.0.0.1:' + str(cls.httpd.server_port)
        cls.cookie = ''
        request = urllib.request.Request(cls.base + '/api/login', data=json.dumps({'username':'TreeCheck','password':'Temporary-page-tree-test'}).encode(), headers={'Origin':'https://family.test','Content-Type':'application/json'})
        with urllib.request.urlopen(request) as response:
            cls.cookie = response.headers['Set-Cookie'].split(';')[0]

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown(); cls.httpd.server_close(); cls.thread.join(); cls.temp.cleanup()

    def request(self, method, path, data=None, auth=True, origin='https://family.test'):
        headers = {'Origin': origin, 'Content-Type':'application/json'}
        if auth: headers['Cookie'] = self.cookie
        request = urllib.request.Request(self.base+path, data=json.dumps(data).encode() if data is not None else None, headers=headers, method=method)
        try: response = urllib.request.urlopen(request)
        except urllib.error.HTTPError as error: response = error
        with response:
            body = response.read()
            return response.status, json.loads(body) if 'application/json' in response.headers.get('Content-Type','') else body

    def create(self, title, parent=None):
        status, body = self.request('POST','/api/pages', {'title':title,'parent_id':parent})
        self.assertEqual(status,201,body)
        return body['page']['id']

    def test_legacy_migration_preserves_content(self):
        status, data = self.request('GET','/api/pages/legacy')
        self.assertEqual(status,200)
        self.assertEqual(data['page']['body'],'Bestaande inhoud')
        self.assertIsNone(data['page']['parent_id'])

    def test_parent_validation_and_content_preserving_move(self):
        a=self.create('A'); b=self.create('B',a); c=self.create('C',b)
        self.assertEqual(self.request('PATCH','/api/pages/'+a,{'parent_id':c})[0],400)
        self.assertEqual(self.request('PATCH','/api/pages/'+a,{'parent_id':a})[0],400)
        self.assertEqual(self.request('POST','/api/pages',{'parent_id':'missing'})[0],400)
        self.request('PATCH','/api/pages/'+b,{'body':'Blijft bewaard','title':'Nieuw'})
        self.assertEqual(self.request('PATCH','/api/pages/'+b,{'parent_id':None})[0],200)
        page=self.request('GET','/api/pages/'+b)[1]['page']
        self.assertEqual((page['title'],page['body'],page['parent_id']),('Nieuw','Blijft bewaard',None))
        self.assertEqual(self.request('GET','/api/pages/'+c)[1]['page']['parent_id'],b)
        self.assertEqual(self.request('PATCH','/api/pages/missing',{'title':'x'})[0],404)

    def test_branch_trash_restore_and_private_attachments(self):
        a=self.create('Root'); b=self.create('Child',a); c=self.create('Grandchild',b)
        self.request('POST',f'/api/pages/{c}/comments',{'body':'Reactie'})
        self.request('POST',f'/api/pages/{c}/files',{'filename':'note.txt','mediaType':'text/plain','data':base64.b64encode(b'attachment').decode()})
        file_id=self.request('GET','/api/pages/'+c)[1]['files'][0]['id']
        status,result=self.request('DELETE','/api/pages/'+a)
        self.assertEqual((status,result['deleted_count']),(200,3))
        active={row['id'] for row in self.request('GET','/api/pages')[1]['items']}
        self.assertFalse({a,b,c}&active)
        self.assertEqual(self.request('GET','/api/pages/'+c)[0],404)
        self.assertEqual(self.request('GET','/api/files/'+file_id)[0],404)
        self.assertEqual(self.request('POST',f'/api/pages/{c}/comments',{'body':'No'})[0],400)
        self.assertEqual(self.request('PATCH','/api/pages/'+c,{'title':'No'})[0],404)
        self.assertEqual(self.request('POST','/api/pages',{'parent_id':a})[0],400)
        self.assertEqual(self.request('POST',f'/api/pages/{a}/restore',{})[1]['restored_count'],3)
        data=self.request('GET','/api/pages/'+c)[1]
        self.assertEqual(data['page']['parent_id'],b)
        self.assertEqual(data['comments'][0]['body'],'Reactie')
        self.assertEqual(self.request('GET','/api/files/'+file_id)[1],b'attachment')

    def test_separate_deletions_are_not_restored_together(self):
        a=self.create('Parent'); b=self.create('Deleted earlier',a)
        self.request('DELETE','/api/pages/'+b)
        self.request('DELETE','/api/pages/'+a)
        self.request('POST',f'/api/pages/{a}/restore',{})
        self.assertEqual(self.request('GET','/api/pages/'+b)[0],404)
        self.request('DELETE','/api/pages/'+a)
        self.request('POST',f'/api/pages/{b}/restore',{})
        self.assertIsNone(self.request('GET','/api/pages/'+b)[1]['page']['parent_id'])

    def test_deleted_page_stays_deleted_when_database_reopens(self):
        seed = self.create('Temporary test page')
        self.request('DELETE','/api/pages/'+seed)
        connection=self.app.db(); connection.close()
        self.assertEqual(self.request('GET','/api/pages/'+seed)[0],404)
        self.assertEqual(self.request('POST',f'/api/pages/{seed}/restore',{})[0],200)

    def test_concurrent_moves_cannot_create_cycle(self):
        a=self.create('Concurrent A'); b=self.create('Concurrent B')
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            futures=[pool.submit(self.request,'PATCH','/api/pages/'+a,{'parent_id':b}),pool.submit(self.request,'PATCH','/api/pages/'+b,{'parent_id':a})]
            self.assertEqual(sorted(f.result()[0] for f in futures),[200,400])

    def test_mutations_require_session_and_origin(self):
        a=self.create('Protected')
        self.assertEqual(self.request('DELETE','/api/pages/'+a,auth=False)[0],401)
        self.assertEqual(self.request('DELETE','/api/pages/'+a,origin='https://foreign.test')[0],403)
        self.assertEqual(self.request('GET','/api/pages?trash=1',auth=False)[0],401)

if __name__ == '__main__':
    unittest.main()
