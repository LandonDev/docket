#!/usr/bin/env bash
# copy-snapshot.sh <snapshot dir> <scratch dir>
# One scratch copy of a pre-update snapshot (scripts/box/sqlite-snapshot.sh makes them; the newest is the deploy's
# rollback copy and is never opened for writing) for the perf kit's real-size benches. Direct I/O, a GiB a piece
# with a breath between, so the page cache and the live service's disk are left alone. Run it under the guard:
#   .temp-code/bin/heavy bun scripts/perf/guarded.ts --cores none bash scripts/perf/copy-snapshot.sh <snapshot> /srv/agents/tmp/perf2-db
# The copy holds his transcripts: its folder is 0700, and nothing boots on it before scripts/perf/scrubCopy.ts has
# scrubbed it and left its marker.
set -euo pipefail
src=${1:?snapshot dir}; dst=${2:?scratch dir}
case "$dst" in /srv/agents/tmp/*|/tmp/*) ;; *) echo "the scratch dir must be under /srv/agents/tmp or /tmp" >&2; exit 2;; esac
[ -e "$dst/docket.db" ] && { echo "$dst already holds a copy: delete it first" >&2; exit 2; }
mkdir -p "$dst"; chmod 700 "$dst"
piece=64   # blocks of 16M: one GiB
for name in docket.db docket-cold.db stats.db; do
  [ -f "$src/$name" ] || continue
  size=$(stat -c %s "$src/$name"); blocks=$(( (size + 16777215) / 16777216 ))
  echo "copy $name: $size bytes"
  at=0
  while [ "$at" -lt "$blocks" ]; do
    dd if="$src/$name" of="$dst/$name" bs=16M skip="$at" seek="$at" count="$piece" iflag=direct oflag=direct conv=notrunc status=none
    at=$(( at + piece ))
    sleep 1
  done
  [ "$(stat -c %s "$dst/$name")" = "$size" ] || { echo "$name: the copy's size differs" >&2; exit 1; }
done
chmod 600 "$dst"/*.db
echo "copied $(basename "$src") to $dst"
