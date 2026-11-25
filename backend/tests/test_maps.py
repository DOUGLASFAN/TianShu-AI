"""Map contract tests: fake upstream, no application writes or external calls."""
import urllib.error
import pytest
from fastapi.testclient import TestClient
from pydantic import SecretStr
from backend.app.main import app
from backend.app.api import maps
from backend.app.core.security import current_user

@pytest.fixture
def client(monkeypatch):
    app.dependency_overrides[current_user]=lambda:object()
    monkeypatch.setattr(maps,'demo_state',lambda:{'phase':'normal'})
    monkeypatch.setattr(maps,'settings',lambda:type('Config',(),{'map_provider':'auto','tianditu_key':None,'arcgis_token':None})())
    yield TestClient(app)
    app.dependency_overrides.clear()

def test_auth_required():
    assert TestClient(app).get('/api/maps/config').status_code==401

def test_public_config_no_secrets(client):
    result=client.get('/api/maps/config').json()['data']
    assert result['preferred']=='esri'
    assert not result['providers'][1]['configured']
    assert 'key' not in str(result).lower() and 'token' not in str(result).lower()

@pytest.mark.parametrize('path,status',[
 ('evil/imagery/1/0/0',404),('esri/evil/1/0/0',404),
 ('esri/imagery/20/0/0',422),('esri/imagery/2/4/0',422),
 ('esri/imagery/2/0/-1',422),('tianditu/imagery/1/0/0',409)])
def test_allowlist_and_bounds(client,path,status):
    assert client.get('/api/maps/tiles/'+path).status_code==status

def test_xyz_to_arcgis_row_column(client):
    url,secret=maps.tile_url('esri','imagery',17,107915,49666)
    assert url.endswith('/tile/17/49666/107915') and not secret

def test_tile_response_no_disk_cache(client,monkeypatch):
    monkeypatch.setattr(maps,'fetch_tile',lambda *args:(b'\xff\xd8\xfffake','image/jpeg'))
    response=client.get('/api/maps/tiles/esri/imagery/1/0/0')
    assert response.status_code==200 and response.content.startswith(b'\xff\xd8')
    assert 'no-store' in response.headers['cache-control']

def test_upstream_error_sanitized(client,monkeypatch):
    def fail(*args):raise ValueError('https://secret.example/?tk=PRIVATE_KEY')
    monkeypatch.setattr(maps,'fetch_tile',fail)
    response=client.get('/api/maps/tiles/esri/imagery/1/0/0')
    assert response.status_code==502 and 'PRIVATE_KEY' not in response.text

def test_key_stays_server_side(client,monkeypatch):
    monkeypatch.setattr(maps,'settings',lambda:type('Config',(),{'map_provider':'auto','tianditu_key':SecretStr('PRIVATE_KEY'),'arcgis_token':None})())
    assert 'PRIVATE_KEY' not in client.get('/api/maps/config').text
    assert maps.tile_url('tianditu','imagery',2,1,0)[1]

def test_html_rejected(client,monkeypatch):
    class Response:
        status_code=200
        def __enter__(self):return self
        def __exit__(self,*args):pass
        def iter_bytes(self):yield b'<html>not a tile</html>'
    monkeypatch.setattr(maps,'require_external',lambda:None)
    monkeypatch.setattr(maps,'http_client',lambda:type('Client',(),{'stream':lambda *a,**k:Response()})())
    with pytest.raises(ValueError,match='MAP_INVALID_IMAGE'):maps.fetch_tile('https://services.arcgisonline.com/x')

def test_private_credentials_remain_server_side(client,monkeypatch):
    monkeypatch.setattr(maps,'settings',lambda:type('Config',(),{'map_provider':'esri','tianditu_key':None,'arcgis_token':SecretStr('PRIVATE_KEY')})())
    result=client.get('/api/maps/config').json()['data']
    assert result['directTemplates']=={} and 'PRIVATE_KEY' not in str(result)

def test_http_pool_reused_and_closed():
    maps.close_http_client()
    first=maps.http_client()
    assert maps.http_client() is first
    maps.close_http_client()
    assert first.is_closed

def test_direct_templates_are_official_and_keyless(client):
    result=client.get('/api/maps/config').json()['data']
    assert result['directTemplates']['imagery'].startswith('https://services.arcgisonline.com/')
    assert not result['demoActive']

def test_body_size_bounded(client,monkeypatch):
    class Response:
        status_code=200
        def __enter__(self):return self
        def __exit__(self,*args):pass
        def iter_bytes(self):yield b'X'*2_000_001
    monkeypatch.setattr(maps,'require_external',lambda:None)
    monkeypatch.setattr(maps,'http_client',lambda:type('Client',(),{'stream':lambda *a,**k:Response()})())
    with pytest.raises(ValueError,match='MAP_TILE_TOO_LARGE'):maps.fetch_tile('https://services.arcgisonline.com/x')

def test_fault_demo_blocks_external_tiles(client,monkeypatch):
    def fail(*args,**kwargs):raise maps.DemoFailure('Demo')
    monkeypatch.setattr(maps,'fetch_tile',fail)
    assert client.get('/api/maps/tiles/esri/imagery/1/0/0').status_code==503
