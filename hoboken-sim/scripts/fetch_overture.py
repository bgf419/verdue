#!/usr/bin/env python3
"""Download the Hoboken slice of Overture Maps (buildings, streets, places, water,
land use, piers, addresses, municipal boundaries) into hoboken-sim/.cache/overture.

Overture publishes GeoParquet on a public S3 bucket. Each file carries per-row-group
bounding-box statistics, so this script reads only the footers plus the few row
groups that overlap Hoboken, using plain HTTP range requests (which honour
HTTPS_PROXY). No AWS credentials or SDK are required.

    python3 hoboken-sim/scripts/fetch_overture.py [--release 2026-08-19.0]
"""
import argparse
import concurrent.futures as cf
import io
import pathlib
import re
import time
import urllib.parse
import urllib.request

import pyarrow as pa
import pyarrow.compute as pc
import pyarrow.parquet as pq

BUCKET = "https://overturemaps-us-west-2.s3.us-west-2.amazonaws.com"
OUT = pathlib.Path(__file__).resolve().parent.parent / ".cache" / "overture"

# Hoboken plus a margin that covers the approach roads in Jersey City and Weehawken.
DETAIL = (-74.0520, 40.7310, -74.0140, 40.7650)
# Wider frame for context layers (river, Manhattan shoreline, regional roads).
CONTEXT = (-74.0750, 40.7150, -73.9750, 40.7800)

LAYERS = [
    ("divisions", "division_area", CONTEXT, "id,names,subtype,class,admin_level,geometry,bbox,is_land", "divisions"),
    ("buildings", "building", DETAIL, "id,names,height,num_floors,subtype,class,geometry,is_underground,bbox", "buildings"),
    # Contact fields (phones, emails, socials) are deliberately not requested.
    ("places", "place", DETAIL, "id,names,categories,basic_category,taxonomy,confidence,brand,operating_status,addresses,geometry,bbox", "places"),
    ("transportation", "segment", CONTEXT, "id,names,subtype,class,subclass,road_flags,rail_flags,level_rules,routes,connectors,access_restrictions,geometry,bbox", "segments"),
    ("base", "land_use", CONTEXT, "id,names,subtype,class,geometry,bbox", "land_use"),
    ("base", "water", CONTEXT, "id,names,subtype,class,geometry,bbox", "water"),
    ("base", "infrastructure", DETAIL, "id,names,subtype,class,geometry,bbox", "infrastructure"),
    ("addresses", "address", DETAIL, "id,street,number,unit,postcode,postal_city,geometry,bbox", "addresses"),
]


def _get(req, tries=5):
    for attempt in range(tries):
        try:
            return urllib.request.urlopen(req, timeout=120)
        except Exception:
            if attempt == tries - 1:
                raise
            time.sleep(2 ** attempt)


def list_objects(prefix):
    out, token = [], None
    while True:
        query = {"list-type": "2", "prefix": prefix}
        if token:
            query["continuation-token"] = token
        body = _get(f"{BUCKET}/?{urllib.parse.urlencode(query)}").read().decode()
        for block in re.findall(r"<Contents>(.*?)</Contents>", body, re.S):
            key = re.search(r"<Key>([^<]+)</Key>", block).group(1)
            size = int(re.search(r"<Size>(\d+)</Size>", block).group(1))
            out.append((key, size))
        more = re.search(r"<NextContinuationToken>([^<]+)</NextContinuationToken>", body)
        if not more:
            return out
        token = more.group(1)


def latest_release():
    body = _get(f"{BUCKET}/?list-type=2&prefix=release/&delimiter=/").read().decode()
    releases = sorted(re.findall(r"<Prefix>release/([^<]+)/</Prefix>", body))
    return releases[-1]


class RangeFile(io.RawIOBase):
    """Read-only, seekable view of an S3 object via HTTP range requests."""

    def __init__(self, key, size):
        self.url = f"{BUCKET}/{urllib.parse.quote(key)}"
        self.size, self.pos = size, 0

    def readable(self):
        return True

    def seekable(self):
        return True

    def tell(self):
        return self.pos

    def seek(self, offset, whence=0):
        self.pos = offset if whence == 0 else self.pos + offset if whence == 1 else self.size + offset
        return self.pos

    def read(self, n=-1):
        if n is None or n < 0:
            n = self.size - self.pos
        if n == 0 or self.pos >= self.size:
            return b""
        end = min(self.size, self.pos + n) - 1
        req = urllib.request.Request(self.url, headers={"Range": f"bytes={self.pos}-{end}"})
        data = _get(req).read()
        self.pos += len(data)
        return data

    def readinto(self, buf):
        data = self.read(len(buf))
        buf[: len(data)] = data
        return len(data)


def _row_group_envelope(meta, index, columns):
    group = meta.row_group(index)
    values = []
    for name in ("bbox.xmin", "bbox.xmax", "bbox.ymin", "bbox.ymax"):
        stats = group.column(columns[name]).statistics
        if stats is None or not stats.has_min_max:
            return None
        values.append((stats.min, stats.max))
    return values[0][0], values[1][1], values[2][0], values[3][1]


def scan(key, size, bbox, columns):
    parquet = pq.ParquetFile(RangeFile(key, size))
    meta = parquet.metadata
    first = meta.row_group(0)
    index = {first.column(j).path_in_schema: j for j in range(first.num_columns)}
    hits = []
    for i in range(meta.num_row_groups):
        env = _row_group_envelope(meta, i, index)
        if env is None or not (env[1] < bbox[0] or env[0] > bbox[2] or env[3] < bbox[1] or env[2] > bbox[3]):
            hits.append(i)
    if not hits:
        return None
    table = parquet.read_row_groups(hits, columns=columns)
    box = table.column("bbox")
    keep = pc.and_(
        pc.and_(pc.greater_equal(pc.struct_field(box, "xmax"), bbox[0]), pc.less_equal(pc.struct_field(box, "xmin"), bbox[2])),
        pc.and_(pc.greater_equal(pc.struct_field(box, "ymax"), bbox[1]), pc.less_equal(pc.struct_field(box, "ymin"), bbox[3])),
    )
    table = table.filter(keep)
    return table if table.num_rows else None


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--release", help="Overture release, e.g. 2026-08-19.0 (default: latest)")
    args = parser.parse_args()
    release = args.release or latest_release()
    OUT.mkdir(parents=True, exist_ok=True)
    print(f"Overture release {release}")
    for theme, kind, bbox, cols, name in LAYERS:
        started = time.time()
        objects = list_objects(f"release/{release}/theme={theme}/type={kind}/")
        tables = []
        with cf.ThreadPoolExecutor(12) as pool:
            for table in pool.map(lambda o: scan(o[0], o[1], bbox, cols.split(",")), objects):
                if table is not None:
                    tables.append(table)
        merged = pa.concat_tables(tables, promote_options="default") if tables else None
        if merged is None:
            raise SystemExit(f"{theme}/{kind}: no rows intersect {bbox}")
        merged = merged.replace_schema_metadata({**(merged.schema.metadata or {}), b"overture_release": release.encode()})
        pq.write_table(merged, OUT / f"{name}.parquet")
        print(f"  {theme}/{kind}: {merged.num_rows} rows from {len(objects)} files in {time.time() - started:.0f}s")


if __name__ == "__main__":
    main()
