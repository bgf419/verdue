#!/usr/bin/env python3
"""Download Citi Bike Jersey City + Hoboken monthly trip files into hoboken-sim/.cache/citibike.

Trip files are published by Lyft/Citi Bike at https://s3.amazonaws.com/tripdata/
(station ids starting with "HB" are Hoboken docks). They contain no rider identity.

    python3 hoboken-sim/scripts/fetch_citibike.py 202509 202606 202607 202608
"""
import io
import pathlib
import re
import sys
import urllib.request
import zipfile

LISTING = "https://s3.amazonaws.com/tripdata?list-type=2&prefix=JC-"
OUT = pathlib.Path(__file__).resolve().parent.parent / ".cache" / "citibike"


def main(months):
    OUT.mkdir(parents=True, exist_ok=True)
    listing = urllib.request.urlopen(LISTING, timeout=60).read().decode()
    keys = re.findall(r"<Key>(JC-\d{6}-citibike-tripdata(?:\.csv)?\.zip)</Key>", listing)
    by_month = {re.search(r"JC-(\d{6})", key).group(1): key for key in keys}
    wanted = months or sorted(by_month)[-4:]
    for month in wanted:
        key = by_month.get(month)
        if not key:
            raise SystemExit(f"No Jersey City trip file published for {month}")
        payload = urllib.request.urlopen(f"https://s3.amazonaws.com/tripdata/{key}", timeout=300).read()
        with zipfile.ZipFile(io.BytesIO(payload)) as archive:
            for member in archive.namelist():
                if member.endswith(".csv") and not member.startswith("__MACOSX"):
                    (OUT / pathlib.Path(member).name).write_bytes(archive.read(member))
                    print(f"{month}: {pathlib.Path(member).name}")


if __name__ == "__main__":
    main(sys.argv[1:])
