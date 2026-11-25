"""Real authenticated trajectory contracts and propagation reference checks."""
from datetime import timedelta
from types import SimpleNamespace
from unittest.mock import patch
import numpy as np
import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from backend.app.main import app
from backend.app.db import SessionLocal
from backend.app.models import Satellite, now
from backend.app.api.explore import sample
from backend.phase1.orbits import from_omm, state_at, instant
from backend.tests.test_phase2 import register, authorization


@pytest.fixture
def client():
    with TestClient(app, headers={'Origin': 'http://testserver'}) as c: yield c


@pytest.fixture
def logged(client): return authorization(register(client)[0])


@pytest.mark.parametrize('path', ['/api/explore/scene', '/api/explore/satellites/25544/trajectory'])
def test_authentication_required(client, path):
    assert client.get(path).status_code == 401


def test_scene_real_coordinates_and_scope(client, logged):
    result = client.get('/api/explore/scene', headers=logged)
    assert result.status_code == 200
    scene = result.json()
    assert 0 < len(scene['satellites']) <= 24
    assert scene['meta']['coordinateFrame'] == 'ITRS/ECEF'
    assert 'not the full catalog' in scene['meta']['scope']
    assert instant(scene['end']) - instant(scene['start']) == timedelta(hours=2)
    for track in scene['satellites']:
        assert len(track['samples']) == 241
        with SessionLocal() as db:
            sat = db.get(Satellite, track['noradId'])
            assert track['version'] == sat.content_hash
            reference = state_at(from_omm(sat.orbit_raw), track['start'])
        assert np.linalg.norm(np.array(track['samples'][0][1:4]) - reference['ecef_m']) < 0.01
        assert all(np.isfinite(row).all() for row in track['samples'])


@pytest.mark.parametrize('norad_id', [25544, 24876, 41866])
def test_trajectory_bounded_and_versioned(client, logged, norad_id):
    at = now().replace(second=0, microsecond=0)
    result = client.get(f'/api/explore/satellites/{norad_id}/trajectory', params={'at': at.isoformat()}, headers=logged)
    assert result.status_code == 200
    data = result.json()['data']
    assert instant(data['start']) <= at <= instant(data['end'])
    assert 100 <= len(data['samples']) <= 1000
    assert len(data['version']) == 64
    assert data['samples'][-1][0] == (instant(data['end']) - instant(data['start'])).total_seconds()
    assert data['dataQuality']['positionType'] == 'orbit_prediction'
    again = client.get(f'/api/explore/satellites/{norad_id}/trajectory', params={'at': at.isoformat()}, headers=logged)
    assert again.json()['data']['samples'] == data['samples']


def test_time_and_missing_satellite_errors(client, logged):
    path = '/api/explore/satellites/25544/trajectory'
    for at, code in [('2026-11-12T10:00:00', 'EXPLICIT_TIMEZONE_REQUIRED'), ((now()+timedelta(days=8)).isoformat(), 'TIME_RANGE_EXCEEDED')]:
        r = client.get(path, params={'at': at}, headers=logged)
        assert r.status_code == 422 and r.json()['error']['code'] == code
        assert r.json()['requestId'] == r.headers['X-Request-ID']
    assert client.get('/api/explore/satellites/999999998/trajectory', headers=logged).status_code == 404


def test_failed_propagation_does_not_cache_invalid_positions():
    sat = SimpleNamespace(norad_id=123, content_hash='invalid', orbit_raw={'bad': True})
    with patch('backend.app.api.explore.cache.get', return_value=None), patch('backend.app.api.explore.cache.put') as put:
        with pytest.raises(HTTPException) as error: sample(sat, now(), 120, 30)
        assert error.value.status_code == 422 and error.value.detail == 'ORBIT_PROPAGATION_FAILED'
        put.assert_not_called()
