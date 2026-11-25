"""Local-only, read-only feasibility API. No production authentication claims."""
import json
from datetime import datetime, timedelta, timezone

from fastapi import FastAPI, HTTPException

from .orbits import ROOT, from_omm, sample_satellites, tracks

app = FastAPI(title="Star Nexus Phase 1 Validation", version="0.1.0")


@app.get("/api/phase1/health")
def health():
    return {"ok": True, "stage": "feasibility-only", "auth": "not implemented"}


_scene = None


@app.get("/api/phase1/scene")
def scene():
    global _scene
    if _scene is not None:
        return _scene
    models = sample_satellites()
    station_cache=ROOT / ".local/data/source-validation/celestrak/gp_stations.json"
    # A fresh checkout still demonstrates the committed three representative objects offline.
    raw = json.loads(station_cache.read_text()) if station_cache.exists() else []
    for row in raw:
        models.setdefault(int(row["NORAD_CAT_ID"]), from_omm(row))
    start = datetime(2026, 11, 12, tzinfo=timezone.utc)
    result = []
    for cat, sat in models.items():
        try:
            result.append({"noradId": cat, "name": sat.name, "samples": tracks(sat, start, 100, 20)})
        except ValueError:
            continue  # Invalid object omitted; source count disclosed below.
    if not result:
        raise HTTPException(503, "No valid orbit samples")
    _scene = {"start": start.isoformat(), "end": (start+timedelta(minutes=100)).isoformat(),
              "source": "CelesTrak 2026-11-12 snapshot", "mode": "simulation", "satellites": result,
              "candidate_count": len(models), "excluded_count": len(models)-len(result)}
    return _scene
