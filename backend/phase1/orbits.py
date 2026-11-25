"""Offline orbital propagation and point-observer feasibility calculations."""
import json
import math
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np
from sgp4.api import SGP4_ERRORS, jday
from sgp4.io import verify_checksum
from skyfield.api import EarthSatellite, Loader, load_file, wgs84
from skyfield.framelib import itrs

ROOT = Path(__file__).resolve().parents[2]
TS = Loader(str(ROOT / ".local/assets/astronomy")).timescale(builtin=True)
EPHEMERIS = ROOT / ".local/assets/astronomy/de421.bsp"


def instant(value):
    if isinstance(value, str):
        value = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if value.tzinfo is None:
        raise ValueError("Explicit timezone required")
    return value.astimezone(timezone.utc)


def from_omm(row):
    data = dict(row)
    for key in ("CENTER_NAME", "REF_FRAME", "TIME_SYSTEM", "MEAN_ELEMENT_THEORY"):
        expected = {"CENTER_NAME": "EARTH", "REF_FRAME": "TEME", "TIME_SYSTEM": "UTC", "MEAN_ELEMENT_THEORY": "SGP4"}[key]
        if data.get(key, expected) != expected:
            raise ValueError(f"Unsupported {key}")
    for key in ("MEAN_MOTION", "ECCENTRICITY", "INCLINATION", "RA_OF_ASC_NODE", "ARG_OF_PERICENTER",
                "MEAN_ANOMALY", "BSTAR", "MEAN_MOTION_DOT", "MEAN_MOTION_DDOT"):
        if not math.isfinite(float(data[key])):
            raise ValueError(f"Nonfinite {key}")
    if not (0 <= float(data["ECCENTRICITY"]) < 1 and float(data["MEAN_MOTION"]) > 0
            and 0 <= float(data["INCLINATION"]) <= 180):
        raise ValueError("Invalid orbital range")
    cat = int(data["NORAD_CAT_ID"])
    if not 0 < cat <= 999999999:
        raise ValueError("Catalog number out of range")
    epoch = datetime.fromisoformat(data["EPOCH"].replace("Z", "+00:00"))
    if epoch.tzinfo is not None:
        epoch = epoch.astimezone(timezone.utc).replace(tzinfo=None)
    data["EPOCH"] = epoch.strftime("%Y-%m-%dT%H:%M:%S.%f")
    return EarthSatellite.from_omm(TS, data)


def from_tle(text):
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    if len(lines) != 3 or not lines[1].startswith("1 ") or not lines[2].startswith("2 "):
        raise ValueError("Expected name plus two TLE lines")
    verify_checksum(lines[1], lines[2])
    if lines[1][2:7] != lines[2][2:7]:
        raise ValueError("Mismatched TLE IDs")
    sat = EarthSatellite(lines[1], lines[2], lines[0], TS)
    if not 0 <= sat.model.ecco < 1 or sat.model.no_kozai <= 0:
        raise ValueError("Invalid TLE orbit")
    return sat


def state_at(sat, value):
    dt = instant(value)
    t = TS.from_datetime(dt)
    jd, fraction = jday(dt.year, dt.month, dt.day, dt.hour, dt.minute, dt.second + dt.microsecond / 1e6)
    code, _, _ = sat.model.sgp4(jd, fraction)
    if code:
        raise ValueError(f"SGP4 {code}: {SGP4_ERRORS.get(code, 'unknown propagation error')}")
    geo = sat.at(t)
    if geo.message:
        raise ValueError(str(geo.message))
    xyz = geo.frame_xyz(itrs).m
    if not np.isfinite(xyz).all():
        raise ValueError("Nonfinite position")
    point = wgs84.geographic_position_of(geo)
    return {"noradId": sat.model.satnum, "time": dt.isoformat(),
            "lat": float(point.latitude.degrees), "lng": float(point.longitude.degrees),
            "alt": float(point.elevation.km), "velocity": float(np.linalg.norm(geo.velocity.km_per_s)),
            "ecef_m": xyz.tolist()}


def tracks(sat, start, minutes=100, step_seconds=20):
    start = instant(start)
    dates = [start + timedelta(seconds=offset) for offset in range(0, minutes * 60 + 1, step_seconds)]
    t = TS.from_datetimes(dates)
    geo = sat.at(t)
    if geo.message is not None and any(message is not None for message in geo.message):
        raise ValueError("SGP4 batch contains propagation errors")
    xyz = geo.frame_xyz(itrs).m
    if not np.isfinite(xyz).all():
        raise ValueError("Nonfinite trajectory")
    point = wgs84.geographic_position_of(geo)
    speed = np.linalg.norm(geo.velocity.km_per_s, axis=0)
    return [{"noradId": sat.model.satnum, "time": date.isoformat(),
             "lat": float(point.latitude.degrees[i]), "lng": float(point.longitude.degrees[i]),
             "alt": float(point.elevation.km[i]), "velocity": float(speed[i]), "ecef_m": xyz[:,i].tolist()}
            for i,date in enumerate(dates)]


def observer(lat=39.9, lng=116.4, elevation_m=0):
    if not (-90 <= lat <= 90 and -180 <= lng <= 180):
        raise ValueError("Invalid observer coordinates")
    return wgs84.latlon(lat, lng, elevation_m=elevation_m)


def altitude(sat, station, dt):
    return float((sat - station).at(TS.from_datetime(instant(dt))).altaz()[0].degrees)


def conditions(sat, station, dt, ephemeris):
    t = TS.from_datetime(instant(dt))
    topocentric = (sat - station).at(t)
    alt, az, distance = topocentric.altaz()
    sun_alt = (ephemeris["earth"] + station).at(t).observe(ephemeris["sun"]).apparent().altaz()[0].degrees
    sunlit = bool(sat.at(t).is_sunlit(ephemeris))
    return {"elevation": float(alt.degrees), "azimuth": float(az.degrees), "range_km": float(distance.km),
            "sun_altitude": float(sun_alt), "sunlit": sunlit}


def visible_windows(sat, station, start, end, ephemeris, min_elevation=10):
    def usable(dt):
        c = conditions(sat, station, dt, ephemeris)
        return c["elevation"] >= min_elevation and c["sun_altitude"] < -6 and c["sunlit"]
    points = [start]
    while points[-1] < end:
        points.append(min(points[-1] + timedelta(seconds=5), end))
    windows, opening = [], start if usable(start) else None
    previous = usable(start)
    for a, b in zip(points, points[1:]):
        current = usable(b)
        if current != previous:
            left, right = a, b
            while (right-left).total_seconds() > 0.5:
                mid = left + (right-left)/2
                if usable(mid) == previous:
                    left = mid
                else:
                    right = mid
            edge = left+(right-left)/2
            if current:
                opening = edge
            elif opening is not None:
                windows.append({"start": opening.isoformat(), "end": edge.isoformat()})
                opening = None
        previous = current
    if opening is not None:
        windows.append({"start": opening.isoformat(), "end": end.isoformat()})
    return windows


def passes(sat, station, start, end, min_elevation=10, ephemeris=None):
    start, end = instant(start), instant(end)
    if not 0 <= min_elevation <= 90 or not start < end or (end-start).days > 7:
        raise ValueError("Invalid prediction interval/threshold")
    times, events = sat.find_events(station, TS.from_datetime(start), TS.from_datetime(end),
                                   altitude_degrees=min_elevation)
    intervals, opening, partial = [], None, False
    if altitude(sat, station, start) >= min_elevation:
        opening, partial = start, True
    peaks = []
    for t, event in zip(times, events):
        dt = t.utc_datetime()
        if event == 0:
            opening, partial, peaks = dt, False, []
        elif event == 1 and opening is not None:
            peaks.append(dt)
        elif event == 2 and opening is not None:
            intervals.append((opening, dt, list(peaks), partial, False))
            opening, peaks = None, []
    if opening is not None:
        intervals.append((opening, end, list(peaks), partial, True))
    result = []
    for a, b, peaks, left_partial, right_partial in intervals:
        best = max([a, b, *peaks], key=lambda dt: altitude(sat, station, dt))
        entry = {"start": a.isoformat(), "peak": best.isoformat(), "end": b.isoformat(),
                 "max_elevation": altitude(sat, station, best), "duration_s": (b-a).total_seconds(),
                 "partial_start": left_partial, "partial_end": right_partial,
                 "continuous": left_partial and right_partial}
        if ephemeris is not None:
            entry["visible_windows"] = visible_windows(sat, station, a, b, ephemeris, min_elevation)
            entry["peak_conditions"] = conditions(sat, station, best, ephemeris)
        result.append(entry)
    return result


def sample_satellites():
    rows = json.loads((ROOT / "assets/data/orbits/representative-2026-11-12.json").read_text(encoding="utf-8"))
    return {int(row["NORAD_CAT_ID"]): from_omm(row) for row in rows}


class OrbitRegistry:
    """Validate a complete candidate batch before replacing any active state."""
    def __init__(self):
        self.models = {}

    def replace(self, rows):
        candidate = {}
        for row in rows:
            model = from_omm(row)
            if model.model.satnum in candidate:
                raise ValueError("Duplicate catalog number")
            candidate[model.model.satnum] = model
        if not candidate:
            raise ValueError("Empty orbit batch")
        self.models = candidate


def load_ephemeris():
    if not EPHEMERIS.is_file():
        raise FileNotFoundError("Run scripts/prepare_phase1_samples.py first")
    return load_file(str(EPHEMERIS))
