"""Validate ISS position and NOAA space-weather sources, with local TTL caches."""
import argparse
import json
import sys
from datetime import datetime, timezone, timedelta
from pathlib import Path
from urllib.parse import urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parent))
import verify_satellite_sources as source

source.CACHE = source.ROOT / ".local/data/source-validation/environment"


def check_iss(data):
    required = {"id", "latitude", "longitude", "altitude", "velocity", "timestamp", "units"}
    assert isinstance(data, dict) and required <= data.keys(), "ISS fields missing"
    assert data["id"] == 25544 and data["units"] == "kilometers"
    assert -90 <= float(data["latitude"]) <= 90 and -180 <= float(data["longitude"]) <= 180
    assert 200 < float(data["altitude"]) < 600 and float(data["velocity"]) > 0
    instant = datetime.fromtimestamp(data["timestamp"], timezone.utc)
    return {"source_time": instant.isoformat(), "age_seconds": (source.utc_now()-instant).total_seconds(),
            "position": {"lat": data["latitude"], "lng": data["longitude"], "alt_km": data["altitude"],
                         "velocity_km_s": data["velocity"] / 3600},
            "note": "Provider km/h converted to km/s; external calculated position, not spacecraft telemetry."}


def check_kp(data):
    assert isinstance(data, list) and data, "Kp list empty"
    if isinstance(data[0], list):
        rows = [dict(zip(data[0], row)) for row in data[1:]]
    else:
        rows = data
    assert rows
    parsed = []
    for row in rows:
        value = float(row.get("Kp", row.get("kp_index")))
        assert 0 <= value <= 9, "Kp out of range"
        parsed.append((source.parse_time(row["time_tag"]), value))
    latest = max(parsed, key=lambda row: row[0])
    return {"record_count": len(rows), "fields": sorted(rows[0]), "latest_kp": latest[1],
            "source_time": latest[0].isoformat(), "age_hours": (source.utc_now()-latest[0]).total_seconds()/3600,
            "note": "Three-hour observed/estimated planetary index, not a local fault measurement."}


def check_alerts(data):
    assert isinstance(data, list), "Alerts must be an array"
    for row in data:
        assert {"product_id", "issue_datetime", "message"} <= row.keys()
        source.parse_time(row["issue_datetime"])
    return {"record_count": len(data), "fields": sorted(data[0]) if data else [],
            "latest_issue": max((row["issue_datetime"] for row in data), default=None),
            "note": "Preserve raw official bulletin type/text; no invented severity."}


def check_gfz(text):
    values, missing, day_count = [], 0, 0
    for line in text.splitlines():
        if not line.strip() or line.startswith("#"):
            continue
        columns = line.split()
        assert len(columns) == 28, "Unexpected GFZ column count"
        day = datetime(int(columns[0]), int(columns[1]), int(columns[2]), tzinfo=timezone.utc)
        definitive = int(columns[-1])
        assert definitive in (0, 1, 2)
        day_count += 1
        for index, raw in enumerate(columns[7:15]):
            kp = float(raw)
            if kp == -1:
                missing += 1
                continue
            assert 0 <= kp <= 9
            values.append({"interval_start": (day+timedelta(hours=3*index)).isoformat(), "kp": kp,
                           "quality": "definitive" if definitive >= 1 else "preliminary_nowcast"})
    assert values
    latest = max(values, key=lambda value: value["interval_start"])
    return {"day_count": day_count, "valid_intervals": len(values), "missing_intervals": missing,
            "latest": latest, "recent": values[-16:], "source_time": latest["interval_start"],
            "note": "Kp already on 0..9 scale; -1 means unavailable, not quiet. Current interval may be partial preliminary nowcast.",
            "license": "Kp CC BY 4.0; sunspot numbers in raw file CC BY-NC 4.0, not used by this validator.",
            "attribution": "GFZ Helmholtz Centre for Geosciences; Matzka et al. 2021, doi:10.5880/Kp.0001"}


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--offline',action='store_true',help='Validate already acquired snapshots; no new HTTP requests')
    parser.add_argument('--report',type=Path,default=source.ROOT / "docs/evidence/environment-sources-2026-11-12.json")
    args=parser.parse_args()
    output=args.report
    definitions = [
        ("iss_position", "https://api.wheretheiss.at/v1/satellites/25544?units=kilometers", 10, check_iss, 'application/json'),
        ("gfz_kp_nowcast", "https://www-app3.gfz-potsdam.de/kp_index/Kp_ap_Ap_SN_F107_nowcast.txt", 10800, check_gfz, 'text/plain'),
    ]
    report = {"task": "S01-03", "checked_at": source.utc_now().isoformat(), "api_key_required": False, "sources": []}
    failed_hosts = set()
    for key, url, ttl, validator, accept in definitions:
        host = urlsplit(url).hostname
        row = {"key": key, "url": url}
        if host in failed_hosts:
            row.update(status="not_attempted", reason="Earlier failure on same host")
        else:
            if args.offline:
                request=json.loads((source.CACHE/f'{key}.request.json').read_text(encoding='utf-8'))
                body=(source.CACHE/f'{key}.json').read_bytes()
                import hashlib
                assert request['status']=='http_200' and hashlib.sha256(body).hexdigest()==request['sha256']
                request=dict(request,delivery='local_snapshot')
            else:
                body, request = source.fetch(key, url, ttl, accept=accept)
            row["request"] = request
            if body is None:
                row["status"] = request["status"]
                failed_hosts.add(host)
            else:
                try:
                    decoded=body.decode('utf-8-sig')
                    row["validation"] = validator(decoded if accept=='text/plain' else json.loads(decoded))
                    row["status"] = "passed"
                except (ValueError, TypeError, KeyError, AssertionError) as error:
                    row.update(status="validation_failed", error=str(error))
                    failed_hosts.add(host)
        report["sources"].append(row)
        print(json.dumps(row, ensure_ascii=True), flush=True)
    report["all_sources_passed"] = all(row["status"] == "passed" for row in report["sources"])
    report['selected_weather_source']='GFZ Kp nowcast'
    report['optional_sources_note']='NOAA JSON endpoints failed TLS, CelesTrak SW CSV returned 406; historical evidence retained. No claims of official alerts ingestion.'
    output.write_text(json.dumps(report, ensure_ascii=False, indent=2)+"\n", encoding="utf-8")
    return 0 if report["all_sources_passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
