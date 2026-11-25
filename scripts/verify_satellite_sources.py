"""S01-02: bounded, sequential CelesTrak source validation using stdlib.

No retries, no redirected requests, and stop on the first upstream/validation error.
Successful payloads are cached under .local; re-runs validate cached data within TTL.
This verifies source schemas, not orbital propagation (S01-04/S01-05).
"""

import argparse
import hashlib
import json
import math
import statistics
import ssl
import subprocess
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CACHE = ROOT / ".local/data/source-validation/celestrak"
GP_FIELDS = ("NORAD_CAT_ID", "OBJECT_NAME", "OBJECT_ID", "EPOCH", "MEAN_MOTION",
             "ECCENTRICITY", "INCLINATION", "RA_OF_ASC_NODE", "ARG_OF_PERICENTER",
             "MEAN_ANOMALY", "BSTAR", "MEAN_MOTION_DOT", "MEAN_MOTION_DDOT")
META_FIELDS = ("NORAD_CAT_ID", "OBJECT_NAME", "OBJECT_ID", "OBJECT_TYPE", "OWNER",
               "LAUNCH_DATE", "DECAY_DATE", "OPS_STATUS_CODE", "ORBIT_CENTER", "ORBIT_TYPE")
SOURCES = (
    ("gp_iss", "gp", "https://celestrak.org/NORAD/elements/gp.php?CATNR=25544&FORMAT=JSON", 7200),
    ("satcat_iss", "satcat", "https://celestrak.org/satcat/records.php?CATNR=25544&FORMAT=JSON", 86400),
    ("gp_stations", "gp", "https://celestrak.org/NORAD/elements/gp.php?GROUP=STATIONS&FORMAT=JSON", 7200),
    ("gp_beidou", "gp", "https://celestrak.org/NORAD/elements/gp.php?GROUP=BEIDOU&FORMAT=JSON", 7200),
    ("gp_active", "gp", "https://celestrak.org/NORAD/elements/gp.php?GROUP=ACTIVE&FORMAT=JSON", 7200),
    ("satcat_active", "satcat", "https://celestrak.org/satcat/records.php?GROUP=ACTIVE&FORMAT=JSON", 86400),
)


def utc_now():
    return datetime.now(timezone.utc)


def parse_time(value):
    date = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    return date.replace(tzinfo=timezone.utc) if date.tzinfo is None else date.astimezone(timezone.utc)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def curl_download(url, body_path, info, direct=False):
    """Explicitly selected Schannel comparison after reviewing Python TLS failure."""
    header_path = body_path.with_suffix(".curl-headers.txt")
    download_path = body_path.with_suffix(".curl-download")
    command = ["curl.exe", "--silent", "--show-error", "--proto", "=https",
               "--connect-timeout", "10", "--max-time", "30", "--max-filesize", "33554432",
               "--retry", "0", "--max-redirs", "0", "--user-agent",
               "StarNexus-Course-SourceValidation/0.1 (sequential; cached)",
               "--header", "Accept: " + info.get("accept", "application/json"), "--dump-header", str(header_path),
               "--output", str(download_path), "--write-out", "%{http_code}", url]
    if direct:
        command[1:1] = ["--noproxy", "*"]
    completed = subprocess.run(command, capture_output=True, timeout=35)
    code = completed.stdout.decode("ascii", errors="replace").strip()
    info["http_status"] = int(code) if code.isdigit() and code != "000" else None
    if completed.returncode:
        info.update(status="transport_error", curl_exit_code=completed.returncode,
                    error=completed.stderr.decode("utf-8", errors="replace")[:1000])
        return None
    headers = {}
    if header_path.exists():
        for line in header_path.read_text(encoding="iso-8859-1").splitlines():
            if line.startswith("HTTP/"):
                headers = {}
            elif ":" in line:
                name, value = line.split(":", 1)
                headers[name.lower()] = value.strip()
    info["response_headers"] = {name: headers.get(name.lower()) for name in (
        "Content-Type", "Content-Length", "Date", "Last-Modified", "ETag", "Retry-After")}
    if info["http_status"] != 200:
        info.update(status="http_error", error=f"HTTP {info['http_status']}; stopped without retry")
        return None
    payload = download_path.read_bytes()
    if len(payload) > 32 * 1024 * 1024:
        info["status"] = "payload_too_large"
        return None
    info.update(status="http_200", size_bytes=len(payload),
                sha256=hashlib.sha256(payload).hexdigest(),
                body_path=body_path.relative_to(ROOT).as_posix())
    return payload


def fetch(key, url, ttl, transport="urllib", review_note=None, accept="application/json"):
    """Cache successful HTTP responses; validate content separately."""
    CACHE.mkdir(parents=True, exist_ok=True)
    suffix = "" if transport == "urllib" else "." + transport
    body_path, record_path = CACHE / f"{key}{suffix}.json", CACHE / f"{key}{suffix}.request.json"
    if record_path.exists():
        old = json.loads(record_path.read_text(encoding="utf-8"))
        last_good = record_path.with_suffix('.last-good.json')
        if (not last_good.exists() and old.get('status') == 'http_200' and body_path.exists()
                and hashlib.sha256(body_path.read_bytes()).hexdigest() == old.get('sha256')):
            last_good.write_text(json.dumps(old, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
        age = (utc_now() - parse_time(old["attempted_at"])).total_seconds()
        if old["url"] == url and old.get("accept", "application/json") == accept and 0 <= age < ttl:
            reviewed_transport_retry = old["status"] == "transport_error" and bool(review_note)
            if old["status"] != "http_200" and not reviewed_transport_retry:
                return None, dict(old, delivery="cached_failure_no_retry", age_seconds=round(age, 2))
            if old["status"] == "http_200" and body_path.exists():
                payload = body_path.read_bytes()
                if hashlib.sha256(payload).hexdigest() == old["sha256"]:
                    return payload, dict(old, delivery="local_cache", age_seconds=round(age, 2))
            if old["status"] == "http_200":
                return None, dict(old, status="cache_invalid", delivery="no_redownload_within_ttl")
    info = {"url": url, "attempted_at": utc_now().isoformat(), "ttl_seconds": ttl,
            "delivery": "network", "transport": transport,
            "accept": accept,
            "redirects_followed": False, "automatic_retries": 0}
    if review_note:
        info["manual_network_review"] = review_note
    request = urllib.request.Request(url, headers={
        "User-Agent": "StarNexus-Course-SourceValidation/0.1 (sequential; cached)",
        "Accept": accept, "Accept-Encoding": "identity",
    })
    started = time.monotonic()
    payload = None
    try:
        if transport in ("curl", "curl-direct"):
            payload = curl_download(url, body_path, info, direct=transport == "curl-direct")
        else:
            context = ssl.create_default_context()
            try:
                import certifi
                context.load_verify_locations(cafile=certifi.where())
                info["trust_store"] = "system + certifi " + certifi.__version__
            except ImportError:
                info["trust_store"] = "system"
            with urllib.request.build_opener(NoRedirect(), urllib.request.HTTPSHandler(context=context)).open(request, timeout=30) as response:
                info["http_status"] = response.status
                info["response_headers"] = {name: response.headers.get(name) for name in (
                    "Content-Type", "Content-Length", "Date", "Last-Modified", "ETag", "Retry-After")}
                payload = response.read(32 * 1024 * 1024 + 1)
                if response.status != 200:
                    info["status"] = "http_error"
                    payload = None
                elif len(payload) > 32 * 1024 * 1024:
                    info["status"] = "payload_too_large"
                    payload = None
                else:
                    info.update(status="http_200", size_bytes=len(payload),
                                sha256=hashlib.sha256(payload).hexdigest(),
                                body_path=body_path.relative_to(ROOT).as_posix())
    except urllib.error.HTTPError as error:
        info.update(status="http_error", http_status=error.code, error=str(error),
                    retry_after=error.headers.get("Retry-After"))
        error.close()
    except (OSError, urllib.error.URLError, subprocess.TimeoutExpired) as error:
        info.update(status="transport_error", error=str(error))
    info["elapsed_ms"] = round((time.monotonic() - started) * 1000, 1)
    if info.get("status") == "http_200" and payload is not None:
        body_path.write_bytes(payload)
        record_path.with_suffix('.last-good.json').write_text(
            json.dumps(info, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    record_path.write_text(json.dumps(info, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return payload, info


def verified_snapshot(key):
    body = (CACHE / f'{key}.json').read_bytes()
    digest = hashlib.sha256(body).hexdigest()
    for file in (CACHE / f'{key}.request.last-good.json', CACHE / f'{key}.request.json'):
        if not file.exists():
            continue
        record = json.loads(file.read_text(encoding='utf-8'))
        if record.get('status') == 'http_200' and record.get('sha256') == digest:
            return body, record
    raise ValueError('SNAPSHOT_HASH_MISMATCH')


def validate(payload, kind):
    rows = json.loads(payload.decode("utf-8-sig"))
    if not isinstance(rows, list) or not rows:
        raise ValueError("Expected a nonempty JSON array")
    required = GP_FIELDS if kind == "gp" else META_FIELDS
    bad, seen, duplicate, ages = [], set(), [], []
    keys = set()
    for index, row in enumerate(rows):
        if not isinstance(row, dict):
            raise ValueError(f"Row {index} is not an object")
        keys.update(row)
        missing = set(required) - row.keys()
        try:
            cat = int(row["NORAD_CAT_ID"])
            if cat <= 0 or cat > 999999999:
                raise ValueError("Catalog number out of documented range")
            if cat in seen:
                duplicate.append(cat)
            seen.add(cat)
            if missing:
                raise ValueError("Missing fields: " + ",".join(sorted(missing)))
            if kind == "gp":
                age = (utc_now() - parse_time(row["EPOCH"])).total_seconds() / 3600
                ages.append(age)
                for field in GP_FIELDS[4:]:
                    if not math.isfinite(float(row[field])):
                        raise ValueError(f"Nonfinite {field}")
                if not (float(row["MEAN_MOTION"]) > 0 and 0 <= float(row["ECCENTRICITY"]) < 1
                        and 0 <= float(row["INCLINATION"]) <= 180):
                    raise ValueError("Unexpected GP physical range")
            else:
                for field in ("LAUNCH_DATE", "DECAY_DATE"):
                    if row[field]:
                        parse_time(row[field])
        except (KeyError, ValueError, TypeError, OverflowError) as error:
            bad.append({"row": index, "error": str(error)})
    result = {"record_count": len(rows), "unique_catalog_count": len(seen),
              "fields": sorted(keys), "missing_or_invalid_count": len(bad),
              "invalid_examples": bad[:5], "duplicate_count": len(duplicate),
              "six_or_more_digit_catalog_count": sum(cat >= 100000 for cat in seen),
              "coverage": {key: {"present": sum(row.get(key) not in (None, "") for row in rows),
                                 "total": len(rows)} for key in required},
              "samples": rows[:2]}
    if ages:
        result["epoch_age_hours_at_validation"] = {
            "min": round(min(ages), 3), "median": round(statistics.median(ages), 3),
            "max": round(max(ages), 3), "older_than_3_days": sum(age > 72 for age in ages),
            "older_than_7_days": sum(age > 168 for age in ages),
            "future_epoch_count": sum(age < 0 for age in ages)}
    if kind == "satcat":
        result["owners"] = sorted({str(row.get("OWNER")) for row in rows if row.get("OWNER")})
        result["object_types"] = sorted({str(row.get("OBJECT_TYPE")) for row in rows})
        result["dedicated_purpose_field_present"] = any("PURPOSE" in field for field in keys)
    result["schema_passed"] = not bad and not duplicate
    return rows, result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--report", type=Path, required=True)
    parser.add_argument("--transport", choices=("urllib", "curl", "curl-direct"), default="urllib",
                        help="curl is an explicitly reviewed Windows TLS comparison, not an automatic retry")
    parser.add_argument("--review-note", help="Document a repaired/reviewed network condition to recheck a cached transport failure; never bypasses HTTP errors")
    args = parser.parse_args()
    report = {"task": "S01-02", "checked_at": utc_now().isoformat(),
              "transport": args.transport,
              "policy": {"sequential": True, "retry_count": 0, "stop_on_first_error": True,
                         "gp_ttl_seconds": 7200, "metadata_ttl_seconds": 86400}, "sources": []}
    data = {}
    stop = None
    for key, kind, url, ttl in SOURCES:
        entry = {"key": key, "kind": kind, "url": url}
        if stop:
            entry.update(status="not_attempted", reason=stop)
        else:
            payload, request = fetch(key, url, ttl, args.transport, args.review_note)
            entry["request"] = request
            if payload is None:
                entry["status"] = request["status"]
                stop = f"Stopped after {key}: {entry['status']}; review before further upstream requests."
            else:
                try:
                    rows, summary = validate(payload, kind)
                    if key.endswith("_iss") and (len(rows) != 1 or int(rows[0]["NORAD_CAT_ID"]) != 25544):
                        raise ValueError("ISS query must return only NORAD 25544")
                    entry.update(status="passed" if summary["schema_passed"] else "validation_failed",
                                 validation=summary)
                    data[key] = rows
                    if entry["status"] != "passed":
                        stop = f"Stopped after {key}: schema validation failed."
                except (ValueError, TypeError, UnicodeError, KeyError) as error:
                    entry.update(status="validation_failed", error=str(error))
                    stop = f"Stopped after {key}: content validation failed."
        report["sources"].append(entry)
        print(json.dumps({"source": key, "status": entry["status"],
                          "http_status": entry.get("request", {}).get("http_status"),
                          "records": entry.get("validation", {}).get("record_count")}), flush=True)
    if "gp_active" in data and "satcat_active" in data:
        gp_ids = {int(row["NORAD_CAT_ID"]) for row in data["gp_active"]}
        meta_ids = {int(row["NORAD_CAT_ID"]) for row in data["satcat_active"]}
        report["active_join"] = {"orbit_count": len(gp_ids), "metadata_count": len(meta_ids),
                                 "matched": len(gp_ids & meta_ids), "orbit_without_metadata": len(gp_ids - meta_ids),
                                 "metadata_without_orbit": len(meta_ids - gp_ids)}
    report["all_sources_passed"] = all(entry["status"] == "passed" for entry in report["sources"])
    report["stop_reason"] = stop
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"report": str(args.report), "all_sources_passed": report["all_sources_passed"]}))
    return 0 if report["all_sources_passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
