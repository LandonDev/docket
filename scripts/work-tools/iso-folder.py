#!/usr/bin/env python3
"""Copies one folder out of an ISO 9660 image by its long names, with no mount and no root.

  python3 -I iso-folder.py <image.iso> <folder/in/the/image> <out dir>

The virtio-win tool (winvm.json) takes the Windows display driver's folder out of Red Hat's driver image with
it. Only what a plain data image needs: the long names of a Joliet descriptor (UCS-2) or of an ISO 9660:1999
enhanced one (bytes as they are), and single-extent files.
"""
import os
import struct
import sys

SECTOR = 2048


def long_names_root(f):
    """The root record of the descriptor that holds long names, and how its names are written."""
    sector = 16
    while True:
        f.seek(sector * SECTOR)
        d = f.read(SECTOR)
        kind = d[0]
        if d[1:6] != b"CD001" or kind == 255:
            raise SystemExit("no long names in this image")
        if kind == 2:
            # a supplementary descriptor: Joliet by its escape sequence, else the enhanced one (version 2)
            if d[88:91] in (b"%/@", b"%/C", b"%/E"):
                return d[156:190], "utf-16-be"
            if d[6] == 2:
                return d[156:190], "utf-8"
        sector += 1


def entries(f, record, names):
    start, size = struct.unpack_from("<I", record, 2)[0], struct.unpack_from("<I", record, 10)[0]
    f.seek(start * SECTOR)
    data = f.read(size)
    at = 0
    while at < len(data):
        n = data[at]
        if n == 0:
            # records never cross a sector: the rest of this one is padding
            at = (at // SECTOR + 1) * SECTOR
            continue
        rec = data[at : at + n]
        at += n
        raw = rec[33 : 33 + rec[32]]
        if raw in (b"\x00", b"\x01"):
            continue
        name = raw.decode(names).split(";")[0]
        yield name, bool(rec[25] & 2), rec


def find(f, record, names, parts):
    for part in parts:
        for name, is_dir, rec in entries(f, record, names):
            if is_dir and name.lower() == part.lower():
                record = rec
                break
        else:
            raise SystemExit(f"no folder {part} in the image")
    return record


def copy(f, record, names, out):
    os.makedirs(out, exist_ok=True)
    for name, is_dir, rec in list(entries(f, record, names)):
        if "/" in name or "\\" in name or name in ("", ".", ".."):
            raise SystemExit(f"a name the image should not hold: {name!r}")
        to = os.path.join(out, name)
        if is_dir:
            copy(f, rec, names, to)
            continue
        start, size = struct.unpack_from("<I", rec, 2)[0], struct.unpack_from("<I", rec, 10)[0]
        f.seek(start * SECTOR)
        with open(to, "wb") as o:
            left = size
            while left:
                chunk = f.read(min(left, 1 << 20))
                if not chunk:
                    raise SystemExit(f"the image ends inside {name}")
                o.write(chunk)
                left -= len(chunk)


def main():
    if len(sys.argv) != 4:
        raise SystemExit(__doc__)
    image, folder, out = sys.argv[1:]
    with open(image, "rb") as f:
        root, names = long_names_root(f)
        copy(f, find(f, root, names, [p for p in folder.replace("\\", "/").split("/") if p]), names, out)


main()
