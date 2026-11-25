"""Regression coverage for source formats and batched rendering coordinates."""
import importlib.util
import json
import unittest
from unittest.mock import patch
from datetime import datetime,timezone
from pathlib import Path

import numpy as np
from backend.phase1.orbits import from_omm, sample_satellites, state_at, tracks

ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('environment_probe',ROOT/'scripts/verify_environment_sources.py')
probe=importlib.util.module_from_spec(spec);spec.loader.exec_module(probe)


class DataContracts(unittest.TestCase):
    def test_iss_km_per_hour_conversion(self):
        data={'id':25544,'latitude':0,'longitude':0,'altitude':420,'velocity':27600,'timestamp':1794432000,'units':'kilometers'}
        self.assertAlmostEqual(probe.check_iss(data)['position']['velocity_km_s'],27600/3600)

    def test_kp_missing_sentinel_and_preliminary(self):
        text='2026 11 12 34649 34649.5 2635 18 1.000 0.333 -1 -1 -1 -1 -1 -1 4 2 -1 -1 -1 -1 -1 -1 -1 -1 -1 -1 0'
        result=probe.check_gfz(text)
        self.assertEqual(result['missing_intervals'],6)
        self.assertEqual(result['valid_intervals'],2)
        self.assertEqual(result['latest']['quality'],'preliminary_nowcast')
        self.assertEqual(result['latest']['kp'],.333)

    def test_unsupported_frames_rejected(self):
        row=json.loads((ROOT/'assets/data/orbits/representative-2026-11-12.json').read_text())[0]
        with self.assertRaises(ValueError):from_omm(dict(row,REF_FRAME='GCRF'))

    def test_batch_and_scalar_coordinates_agree(self):
        dt=datetime(2026,11,12,tzinfo=timezone.utc)
        for sat in sample_satellites().values():
            batch=tracks(sat,dt,2,20)
            for item in batch:
                scalar=state_at(sat,item['time'])
                self.assertLess(np.linalg.norm(np.array(item['ecef_m'])-scalar['ecef_m']),.001)

    def test_naive_time_not_accepted_as_local_timezone(self):
        with self.assertRaises(ValueError):state_at(sample_satellites()[25544],datetime(2026,11,12))

    def test_scene_works_without_global_catalogue_cache(self):
        from backend.phase1 import server
        with patch.object(server,'ROOT',ROOT/'.local/nonexistent-clean-checkout'),patch.object(server,'_scene',None):
            scene=server.scene()
        self.assertEqual(scene['candidate_count'],3)
        self.assertEqual(len(scene['satellites']),3)
        self.assertEqual(scene['excluded_count'],0)
        self.assertTrue(all(len(s['samples'])==301 for s in scene['satellites']))


if __name__=='__main__':unittest.main()
