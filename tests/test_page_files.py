"""HTTP/storage regressions for page media and authenticated range requests."""
import io
import os
import json
from pathlib import Path
import unittest
import urllib.request
import urllib.error
import uuid
import page_files
import test_page_tree as harness


class PageFileTests(unittest.TestCase):
    setUpClass = classmethod(harness.PageTreeTests.setUpClass.__func__)
    tearDownClass = classmethod(harness.PageTreeTests.tearDownClass.__func__)
    request = harness.PageTreeTests.request
    create = harness.PageTreeTests.create

    def raw(self, method, path, body=None, headers=None, auth=True, origin='https://family.test'):
        values = {'Origin':origin, 'Content-Type':'application/octet-stream'}
        if auth: values['Cookie'] = self.cookie
        values.update(headers or {})
        req = urllib.request.Request(self.base + path, data=body, method=method, headers=values)
        try: response = urllib.request.urlopen(req)
        except urllib.error.HTTPError as error: response = error
        with response: return response.status, response.headers, response.read()

    def upload(self, page, body, filename='test.pdf', upload_id=None, **kwargs):
        return self.raw('POST', f'/api/pages/{page}/files', body, {
            'X-Page-Upload-ID':upload_id or uuid.uuid4().hex, 'X-File-Name':filename}, **kwargs)

    def test_bytes_survive_reopen_and_retry_is_idempotent(self):
        page = self.create('Stored upload')
        content = b'%PDF-1.7\noriginal\x00bytes'
        upload_id = uuid.uuid4().hex
        status, _, body = self.upload(page, content, upload_id=upload_id)
        self.assertEqual(status, 201, body)
        item = json.loads(body)['item']
        self.assertEqual(item['media_type'], 'application/pdf')
        self.assertEqual(item['size'], len(content))
        path = self.app.UPLOAD_DIR / item['id']
        self.assertEqual(path.read_bytes(), content)
        # Windows uses inherited ACLs, not POSIX permission bits.
        if os.name != 'nt':
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        # A new connection (as after restart) reads the committed file reference.
        db = self.app.db()
        self.assertEqual(db.execute('SELECT size FROM files WHERE id=?',(item['id'],)).fetchone()[0], len(content))
        db.close()
        retry = self.upload(page, content, upload_id=upload_id)
        self.assertEqual(json.loads(retry[2])['item']['id'], item['id'])
        self.assertEqual(self.upload(page,b'different',upload_id=upload_id)[0],409)
        self.assertEqual(len(self.request('GET','/api/pages/'+page)[1]['files']), 1)
        self.assertEqual(self.raw('GET','/api/files/'+item['id'])[2],content)

    def test_access_origin_trash_and_restore(self):
        page = self.create('Private media')
        self.assertEqual(self.upload(page,b'private',auth=False)[0],401)
        self.assertEqual(self.upload(page,b'private',origin='https://foreign.test')[0],403)
        item = json.loads(self.upload(page,b'private')[2])['item']
        url = '/api/files/' + item['id'] + '?preview=1'
        self.assertEqual(self.raw('GET',url,auth=False)[0],401)
        self.request('DELETE','/api/pages/'+page)
        self.assertEqual(self.raw('GET',url)[0],404)
        self.assertEqual(self.upload(page,b'private')[0],404)
        self.request('POST',f'/api/pages/{page}/restore',{})
        self.assertEqual(self.raw('GET',url)[2],b'private')
        for path in ['/page_files.py','/private/data/files/'+item['id'],'/files/'+item['id']]:
            self.assertEqual(self.raw('GET',path,auth=False)[0],401)

    def test_preview_range_and_download_headers(self):
        page = self.create('Video')
        content = b'\x00\x00\x00\x18ftypisom' + bytes(range(256))*10
        item = json.loads(self.upload(page,content,'clip.mp4')[2])['item']
        url = '/api/files/' + item['id']
        status, headers, result = self.raw('GET',url+'?preview=1',headers={'Range':'bytes=10-99'})
        self.assertEqual(status,206)
        self.assertEqual(result,content[10:100])
        self.assertEqual(headers['Content-Type'],'video/mp4')
        self.assertEqual(headers['Content-Range'],f'bytes 10-99/{len(content)}')
        self.assertTrue(headers['Content-Disposition'].startswith('inline;'))
        self.assertEqual(headers['Cache-Control'],'private, no-store')
        self.assertEqual(self.raw('GET',url,headers={'Range':'bytes=-7'})[2],content[-7:])
        self.assertEqual(self.raw('GET',url,headers={'Range':'bytes=3-'})[2],content[3:])
        for value in ['bytes=99999-','bytes=9-3','bytes=-0','bytes=1-2,3-4','bad']:
            self.assertEqual(self.raw('GET',url,headers={'Range':value})[0],416,value)
        headers = self.raw('GET',url)[1]
        self.assertEqual(headers['Content-Type'],'application/octet-stream')
        self.assertTrue(headers['Content-Disposition'].startswith('attachment;'))

    def test_active_content_disguised_as_image_is_download_only(self):
        page = self.create('Untrusted file')
        content = b'<svg onload="alert(1)"></svg>'
        item = json.loads(self.upload(page,content,'picture.png')[2])['item']
        self.assertEqual(item['media_type'],'application/octet-stream')
        _, headers, body = self.raw('GET','/api/files/'+item['id']+'?preview=1')
        self.assertTrue(headers['Content-Disposition'].startswith('attachment;'))
        self.assertIn('sandbox',headers['Content-Security-Policy'])
        self.assertEqual(body,content)

    def test_limits_partial_upload_and_deleted_during_upload_leave_no_files(self):
        page = self.create('Interrupted upload')
        folder = self.app.UPLOAD_DIR
        before = set(folder.iterdir())
        db = self.app.db()
        headers = {'Content-Length':'10','X-Page-Upload-ID':uuid.uuid4().hex,'X-File-Name':'partial.pdf'}
        with self.assertRaises(page_files.UploadError):
            page_files.store_upload(db,folder,page,'TreeCheck',headers,io.BytesIO(b'short'),'now')
        for length in ['0',str(page_files.MAX_FILE_SIZE+1),'-1','bad']:
            headers['Content-Length']=length
            with self.assertRaises(page_files.UploadError):
                page_files.store_upload(db,folder,page,'TreeCheck',headers,io.BytesIO(b''),'now')
        headers['Content-Length']='5'
        class DeleteOnRead(io.BytesIO):
            def read(stream, count):
                self.request('DELETE','/api/pages/'+page)
                return super().read(count)
        with self.assertRaises(page_files.UploadError):
            page_files.store_upload(db,folder,page,'TreeCheck',headers,DeleteOnRead(b'hello'),'now')
        db.close()
        self.assertEqual(set(folder.iterdir()),before)
        self.assertEqual(list(folder.glob('.upload-*')),[])

    def test_word_bytes_and_unicode_name_preserved(self):
        from urllib.parse import quote, unquote
        page=self.create('Word file')
        name='Vakantie ideeën (1).docx'
        content=b'PK\x03\x04word-document-bytes'
        result=self.upload(page,content,quote(name,safe=''))
        item=json.loads(result[2])['item']
        self.assertEqual(item['filename'],name)
        _,headers,body=self.raw('GET','/api/files/'+item['id'])
        self.assertEqual(body,content)
        self.assertIn(name,unquote(headers['Content-Disposition']))

    def test_embed_policy_keeps_scripts_private_and_limits_frames(self):
        _,headers,_=self.raw('GET','/',auth=False)
        csp=headers['Content-Security-Policy']
        self.assertIn("script-src 'self';",csp)
        self.assertIn("frame-src 'self' https://www.youtube-nocookie.com",csp)
        self.assertIn("frame-ancestors 'none'",csp)
        self.assertIn("object-src 'none'",csp)

    def test_binary_upload_exceeds_old_json_limit(self):
        import hashlib
        page=self.create('Large upload')
        content=b'large-file-test-' * (10*1024*1024//16+1)
        status,_,body=self.upload(page,content,'large.bin')
        self.assertEqual(status,201,body)
        item=json.loads(body)['item']
        self.assertEqual(item['size'],len(content))
        self.assertEqual(hashlib.sha256(self.raw('GET','/api/files/'+item['id'])[2]).digest(),hashlib.sha256(content).digest())
