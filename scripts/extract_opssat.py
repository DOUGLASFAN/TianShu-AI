"""Reproduce the committed OPSSAT-AD slice from the original Zenodo segments.csv."""
import argparse
import csv
import hashlib
import io
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE_HASH = 'd5201e9e751eb2a53a0ff7c11567dc4239f594ea4b479b2aa66fe67ddcbcb9ba'


def extract(source):
    raw = source.read_bytes()
    if hashlib.sha256(raw).hexdigest() != SOURCE_HASH:
        raise ValueError('OPSSAT-AD v2 segments.csv digest mismatch')
    reader = csv.DictReader(io.StringIO(raw.decode('utf8')))
    cases = ('5', '1', '8')
    groups = {key: [] for key in cases}
    for row in reader:
        if row['channel'] == 'CADC0872' and row['segment'] in groups:
            groups[row['segment']].append(row)
    out = io.StringIO(newline='')
    writer = csv.DictWriter(out, fieldnames=reader.fieldnames, lineterminator='\n')
    writer.writeheader()
    for case in cases:
        writer.writerows(groups[case])
    return out.getvalue().encode()


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('source', type=Path)
    parser.add_argument('output', type=Path)
    args = parser.parse_args()
    args.output.write_bytes(extract(args.source))
