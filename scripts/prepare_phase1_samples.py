"""Freeze representative source subsets; never re-fetch the global catalogue."""
import argparse
import hashlib
import importlib.metadata
import json
import shutil
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--ephemeris-only',action='store_true',help='Prepare local DE421 using installed package; retain committed orbit samples')
    args=parser.parse_args()
    if args.ephemeris_only:
        target=ROOT/'.local/assets/astronomy/de421.bsp'
        target.parent.mkdir(parents=True,exist_ok=True)
        bundle=Path(importlib.metadata.distribution('skyfield-data').locate_file('skyfield_data/data/de421.bsp'))
        shutil.copyfile(bundle,target)
        print(json.dumps({'ephemeris':str(target),'sha256':digest(target)}))
        return
    cache = ROOT / ".local/data/source-validation/celestrak"
    output = ROOT / "assets/data/orbits"
    output.mkdir(parents=True, exist_ok=True)
    rows = json.loads((cache / "gp_active.json").read_text(encoding="utf-8"))
    ids = [25544, 43001, 41866]
    selected = [next(row for row in rows if int(row["NORAD_CAT_ID"]) == cat) for cat in ids]
    gp = output / "representative-2026-11-12.json"
    gp.write_text(json.dumps(selected, ensure_ascii=False, indent=2)+"\n", encoding="utf-8")
    tle = output / "iss-2026-11-12.tle"
    shutil.copyfile(cache / "gp_iss_tle.json", tle)
    request = json.loads((cache / "gp_active.request.json").read_text(encoding="utf-8"))
    tle_request = json.loads((cache / "gp_iss_tle.request.json").read_text(encoding="utf-8"))
    astronomy = ROOT / ".local/assets/astronomy"
    astronomy.mkdir(parents=True, exist_ok=True)
    # Copy only the valid planetary kernel; do not use the expired IERS file in this package.
    bundle = Path(importlib.metadata.distribution("skyfield-data").locate_file("skyfield_data/data/de421.bsp"))
    kernel = astronomy / "de421.bsp"
    shutil.copyfile(bundle, kernel)
    manifest = {
        "prepared_at": datetime.now(timezone.utc).isoformat(),
        "gp": {"file": gp.relative_to(ROOT).as_posix(), "sha256": digest(gp), "source": request,
               "ids": ids, "selection": "ISS LEO, BEIDOU-3 M1 navigation MEO, GOES 16 GEO"},
        "tle": {"file": tle.relative_to(ROOT).as_posix(), "sha256": digest(tle), "source": tle_request},
        "ephemeris": {"file": kernel.relative_to(ROOT).as_posix(), "sha256": digest(kernel),
                      "size_bytes": kernel.stat().st_size, "distribution": "skyfield-data",
                      "version": importlib.metadata.version("skyfield-data"),
                      "source": "https://pypi.org/project/skyfield-data/", "origin": "NASA/JPL DE421",
                      "note": "Direct JPL download failed TLS; obtained packaged kernel. Expired bundled IERS file NOT used; timescale builtin=True."},
    }
    (output / "manifest-2026-11-12.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2)+"\n", encoding="utf-8")
    print(json.dumps({"ids": ids, "ephemeris_bytes": kernel.stat().st_size}))


if __name__ == "__main__":
    main()
