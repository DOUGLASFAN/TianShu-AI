"""Offline schema checks only. Fixtures are synthetic, never real orbit samples."""

import importlib.util
import json
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location(
    "source_probe", Path(__file__).resolve().parents[1] / "scripts/verify_satellite_sources.py")
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)


def synthetic_gp():
    return {"NORAD_CAT_ID": 123456, "OBJECT_NAME": "SYNTHETIC TEST ONLY",
            "OBJECT_ID": "2026-001A", "EPOCH": "2026-11-12T00:00:00",
            "MEAN_MOTION": 15.0, "ECCENTRICITY": 0.001, "INCLINATION": 51.0,
            "RA_OF_ASC_NODE": 10.0, "ARG_OF_PERICENTER": 20.0, "MEAN_ANOMALY": 30.0,
            "BSTAR": 0.0, "MEAN_MOTION_DOT": 0.0, "MEAN_MOTION_DDOT": 0.0}


def encoded(rows):
    return json.dumps(rows).encode("utf-8")


class SourceValidationTests(unittest.TestCase):
    def test_structured_gp_supports_six_digit_id(self):
        _, result = probe.validate(encoded([synthetic_gp()]), "gp")
        self.assertTrue(result["schema_passed"])
        self.assertEqual(result["six_or_more_digit_catalog_count"], 1)

    def test_missing_field_does_not_pass(self):
        row = synthetic_gp()
        del row["BSTAR"]
        _, result = probe.validate(encoded([row]), "gp")
        self.assertFalse(result["schema_passed"])

    def test_invalid_eccentricity_does_not_pass(self):
        row = synthetic_gp()
        row["ECCENTRICITY"] = 1.5
        _, result = probe.validate(encoded([row]), "gp")
        self.assertFalse(result["schema_passed"])

    def test_nonfinite_values_do_not_pass(self):
        row = synthetic_gp()
        row["MEAN_MOTION"] = "NaN"
        _, result = probe.validate(encoded([row]), "gp")
        self.assertFalse(result["schema_passed"])

    def test_duplicates_do_not_pass(self):
        _, result = probe.validate(encoded([synthetic_gp(), synthetic_gp()]), "gp")
        self.assertFalse(result["schema_passed"])
        self.assertEqual(result["duplicate_count"], 1)

    def test_html_and_empty_data_do_not_pass(self):
        for payload in (b"<html>Service error</html>", b"[]", b"{}"):
            with self.subTest(payload=payload), self.assertRaises(ValueError):
                probe.validate(payload, "gp")

    def test_metadata_nullable_decay_and_absent_purpose(self):
        row = {key: None for key in probe.META_FIELDS}
        row.update(NORAD_CAT_ID=123456, OBJECT_NAME="SYNTHETIC TEST ONLY",
                   OBJECT_TYPE="PAY", OWNER="TEST", LAUNCH_DATE="2026-01-01",
                   OPS_STATUS_CODE="+", ORBIT_CENTER="EA", ORBIT_TYPE="ORB")
        _, result = probe.validate(encoded([row]), "satcat")
        self.assertTrue(result["schema_passed"])
        self.assertFalse(result["dedicated_purpose_field_present"])
        self.assertEqual(result["coverage"]["DECAY_DATE"]["present"], 0)

    def test_documented_naive_epoch_is_utc(self):
        self.assertEqual(probe.parse_time("2026-11-12T00:00:00").isoformat(),
                         "2026-11-12T00:00:00+00:00")


if __name__ == "__main__":
    unittest.main()
