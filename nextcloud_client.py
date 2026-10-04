"""Per-family-account Nextcloud login flow and read-only filename search."""
from __future__ import annotations
import base64
import json
import os
import secrets
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path
from xml.sax.saxutils import escape
from cryptography.fernet import Fernet

from config import SETTINGS, MEMBERS
BASE = SETTINGS.get('nextcloud_url', '').rstrip('/')
LOCK = threading.RLock()
PENDING = {}

class CloudError(Exception):
    def __init__(self, message, status=502):
        super().__init__(message)
        self.status = status

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None

def safe_url(url):
    parsed = urllib.parse.urlsplit(url)
    if not BASE or parsed.scheme != 'https' or parsed.netloc != urllib.parse.urlsplit(BASE).netloc or parsed.username or parsed.password:
        raise CloudError('Nextcloud gaf een onverwacht serveradres terug.')
    return url

def request(path, method='GET', data=None, credentials=None, content_type=None, pending_ok=False):
    url = safe_url(path if path.startswith('https://') else BASE + path)
    headers = {'Accept':'application/json', 'User-Agent':'Thuis', 'OCS-APIRequest':'true'}
    if credentials:
        headers['Authorization'] = 'Basic ' + base64.b64encode((credentials['login'] + ':' + credentials['password']).encode()).decode()
    if content_type:
        headers['Content-Type'] = content_type
    try:
        with urllib.request.build_opener(NoRedirect).open(urllib.request.Request(url, data=data, headers=headers, method=method), timeout=18) as response:
            body = response.read(2_000_001)
            if len(body)>2_000_000:
                raise CloudError('Te veel resultaten. Maak de zoekopdracht specifieker.')
            return body
    except urllib.error.HTTPError as error:
        if pending_ok and error.code == 404:
            return None
        if error.code in (401,403):
            raise CloudError('Nextcloud geeft geen toegang. Verbind je account opnieuw.', 409) from None
        raise CloudError('Nextcloud kon dit verzoek niet uitvoeren. Probeer het opnieuw.') from None
    except (urllib.error.URLError, TimeoutError, OSError):
        raise CloudError('Nextcloud is even niet bereikbaar. Probeer het opnieuw.') from None

def folder(private_dir):
    path = Path(private_dir) / 'nextcloud'
    path.mkdir(mode=0o700, exist_ok=True)
    return path

def credential_path(private_dir, user):
    if user not in MEMBERS:
        raise CloudError('Dit account heeft geen toegang tot deze koppeling.',403)
    return folder(private_dir) / ('member'+str(MEMBERS.index(user)+1)+'.enc')

def cipher(private_dir):
    key_file = folder(private_dir) / 'key'
    if not key_file.exists():
        try:
            fd = os.open(key_file,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
            with os.fdopen(fd,'wb') as stream:
                stream.write(Fernet.generate_key())
        except FileExistsError:
            pass
    return Fernet(key_file.read_bytes())

def read_credentials(private_dir,user):
    path=credential_path(private_dir,user)
    if not path.exists():
        return None
    try:
        return json.loads(cipher(private_dir).decrypt(path.read_bytes()))
    except Exception:
        raise CloudError('De opgeslagen koppeling kan niet worden geopend. Verbind opnieuw.',409) from None

def store_credentials(private_dir,user,value):
    path=credential_path(private_dir,user)
    temp=path.with_suffix('.'+secrets.token_hex(5)+'.tmp')
    fd=os.open(temp,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
    try:
        with os.fdopen(fd,'wb') as stream:
            stream.write(cipher(private_dir).encrypt(json.dumps(value).encode()))
        os.replace(temp,path)
    finally:
        temp.unlink(missing_ok=True)

def status(private_dir,user):
    with LOCK:
        credentials=read_credentials(private_dir,user)
        pending=PENDING.get(user)
        if pending and pending['expires']<time.monotonic():
            PENDING.pop(user,None); pending=None
        return {'connected':bool(credentials),'account':credentials['login'] if credentials else '', 'pending':bool(pending), 'login_url':pending['login_url'] if pending else None}

def connect(private_dir,user):
    if not BASE:
        raise CloudError("Stel eerst je eigen Nextcloud-adres in config.json in.", 409)
    with LOCK:
        credential_path(private_dir,user)
        pending=PENDING.get(user)
        if pending and pending['expires']>time.monotonic():
            return {'login_url':pending['login_url']}
        data=json.loads(request('/index.php/login/v2',method='POST',data=b''))
        login=safe_url(data['login']); endpoint=safe_url(data['poll']['endpoint']); token=data['poll']['token']
        if not isinstance(token,str) or len(token)>4096:
            raise CloudError('Nextcloud gaf een ongeldig inlogverzoek terug.')
        PENDING[user]={'login_url':login,'endpoint':endpoint,'token':token,'expires':time.monotonic()+1200}
        return {'login_url':login}

def poll(private_dir,user):
    with LOCK:
        pending=PENDING.get(user)
        if not pending or pending['expires']<time.monotonic():
            PENDING.pop(user,None)
            return {**status(private_dir,user),'pending':False}
        # Persist a received one-time credential before making any further network calls.
        body=request(pending['endpoint'],method='POST',data=urllib.parse.urlencode({'token':pending['token']}).encode(),content_type='application/x-www-form-urlencoded',pending_ok=True)
        if body is None:
            return {'connected':False,'pending':True}
        data=json.loads(body)
        if data.get('server','').rstrip('/') != BASE:
            raise CloudError('De koppeling hoort bij een andere Nextcloud-server.')
        login,password=data.get('loginName'),data.get('appPassword')
        if not isinstance(login,str) or not login or not isinstance(password,str) or not password:
            raise CloudError('Nextcloud gaf geen geldige koppeling terug.')
        store_credentials(private_dir,user,{'login':login,'password':password})
        PENDING.pop(user,None)
        return {'connected':True,'pending':False,'account':login}

def disconnect(private_dir,user):
    with LOCK:
        credentials=read_credentials(private_dir,user)
        revoked=True
        if credentials:
            try:
                request('/ocs/v2.php/core/apppassword',method='DELETE',credentials=credentials)
            except CloudError:
                revoked=False
        credential_path(private_dir,user).unlink(missing_ok=True)
        PENDING.pop(user,None)
        return {'connected':False,'revoked':revoked}

def search(private_dir,user,term):
    if not isinstance(term,str) or not 2<=len(term.strip())<=150:
        raise CloudError('Typ 2 tot 150 tekens om op bestandsnaam te zoeken.',400)
    with LOCK:
        credentials=read_credentials(private_dir,user)
    if not credentials:
        raise CloudError('Verbind eerst je Nextcloud-account.',409)
    user_info=json.loads(request('/ocs/v2.php/cloud/user?format=json',credentials=credentials))
    uid=user_info.get('ocs',{}).get('data',{}).get('id')
    if not isinstance(uid,str) or not uid:
        raise CloudError('Je Nextcloud-account kon niet worden opgehaald.')
    pattern='%' + term.strip().replace('\\','\\\\').replace('%','\\%').replace('_','\\_') + '%'
    xml=f'''<?xml version="1.0" encoding="UTF-8"?><d:searchrequest xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns"><d:basicsearch><d:select><d:prop><oc:fileid/><d:displayname/><d:getcontenttype/><oc:size/></d:prop></d:select><d:from><d:scope><d:href>/files/{escape(urllib.parse.quote(uid,safe=''))}</d:href><d:depth>infinity</d:depth></d:scope></d:from><d:where><d:and><d:not><d:is-collection/></d:not><d:like caseless="yes"><d:prop><d:displayname/></d:prop><d:literal>{escape(pattern)}</d:literal></d:like></d:and></d:where><d:orderby><d:order><d:prop><d:displayname/></d:prop><d:ascending/></d:order></d:orderby><d:limit><d:nresults>51</d:nresults></d:limit></d:basicsearch></d:searchrequest>'''
    body=request('/remote.php/dav/',method='SEARCH',data=xml.encode(),content_type='application/xml; charset=utf-8',credentials=credentials)
    if b'<!DOCTYPE' in body.upper() or b'<!ENTITY' in body.upper():
        raise CloudError('Nextcloud gaf een ongeldig zoekantwoord terug.')
    items=[]
    for response in ET.fromstring(body).findall('{DAV:}response'):
        prop=None
        for propstat in response.findall('{DAV:}propstat'):
            if ' 200 ' in propstat.findtext('{DAV:}status',''):
                prop=propstat.find('{DAV:}prop');break
        if prop is None:
            continue
        file_id=prop.findtext('{http://owncloud.org/ns}fileid','')
        if not file_id.isdigit():
            continue
        path=urllib.parse.unquote(urllib.parse.urlsplit(response.findtext('{DAV:}href','')).path)
        prefix='/remote.php/dav/files/'+uid+'/'
        if path.startswith(prefix):path=path[len(prefix):]
        items.append({'id':file_id,'title':prop.findtext('{DAV:}displayname') or path.rsplit('/',1)[-1], 'path':path, 'url':BASE+'/index.php/f/'+file_id})
    return {'items':items[:50],'has_more':len(items)>50}
