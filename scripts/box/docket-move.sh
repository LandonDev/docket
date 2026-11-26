#!/usr/bin/env bash
# The box's half of the move to Docket's names (docs/agents/docket-data-move.md
# "The box"). As root, from the deployed build's own scripts/box:
#
#   bash docket-move.sh [--stop-service] [--dry-run] [--undo]
#
# Three folders move to their new names, each by one rename on the same disk,
# and a link at each old name points to the new one:
#   /srv/agents/temp-code-data   -> docket-data    the app's data
#   /srv/agents/temp-code-builds -> docket-builds  the release builds
#   /srv/agents/home/.temp-code  -> .docket        worktrees, attachments
# Every path stored or set by an old name (/etc/temp-code.env, the unit, the
# builds' current and previous links, git's worktree records, thread rows)
# still resolves, so nothing is rewritten and nothing is copied. The app
# renames temp-code.db to docket.db itself when it next starts (dataMove.ts).
# Beside the moves: AppArmor's grant covers docket-builds, restic leaves out
# the new folders' live databases and builds, and box-update and
# box-sqlite-snapshot come from this folder, as stages 85 and 75 would put them.
#
# All three folders are checked before one changes, and two real folders are
# never merged. Safe to run again: what is done is said and left. While the
# service runs it refuses, unless --stop-service: then it stops the service,
# moves, and starts it again. A run that fails partway leaves the service
# stopped and says so; run it again to finish. --undo puts the old names back,
# the databases' too, and leaves a link at each new name. --dry-run says what
# a run would do and changes nothing.
set -Eeuo pipefail
umask 022
usage='Usage: docket-move.sh [--stop-service] [--dry-run] [--undo]'
stop=0 dry=0 undo=0
for arg; do
  case $arg in
    --stop-service) stop=1 ;;
    --dry-run) dry=1 ;;
    --undo) undo=1 ;;
    *) echo "$usage" >&2; exit 2 ;;
  esac
done
here=$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")
# A rehearsal runs every step on a scratch tree as any user, with the service
# and AppArmor stood in for by files (scripts/box/docketMove.test.ts).
top=${DOCKET_MOVE_REHEARSAL:-}
if [[ -n $top ]]; then
  systemctl() {
    case $1 in
      is-active) [[ $(cat "$top/service" 2>/dev/null) == active ]] ;;
      stop) echo inactive > "$top/service" ;;
      start) echo active > "$top/service" ;;
    esac
  }
  apparmor_parser() { echo "$*" >> "$top/apparmor-reloads"; }
  as_owner() { "${@:2}"; }
  mkdir -p "$top/run/lock"
else
  [[ $EUID == 0 ]] || { echo "ERROR: run as root. $usage" >&2; exit 2; }
  as_owner() { runuser -u "$(stat -c %U "$1")" -- "${@:2}"; }
fi
agents=$top/srv/agents
olds=("$agents/temp-code-data" "$agents/temp-code-builds" "$agents/home/.temp-code")
news=("$agents/docket-data" "$agents/docket-builds" "$agents/home/.docket")
apparmor=$top/etc/apparmor.d/temp-code
excludes=$top/etc/restic/excludes
unit=temp-code.service
stopped=0

say() { if ((dry)); then echo "WOULD: $*"; else echo "DONE: $*"; fi; }
die() {
  echo "ERROR: $*" >&2
  if ((stopped)); then echo "ERROR: $unit is left stopped. Run this again to finish." >&2; fi
  exit 1
}
trap 'die "stopped partway at line $LINENO; what is DONE above stays done."' ERR
# One rename(2), never a copy: across disks it fails and nothing has changed.
rename() { python3 -c 'import os, sys; os.rename(sys.argv[1], sys.argv[2])' "$1" "$2"; }
# A link at $1 by its neighbour $2's name, owned as $2.
link() { ln -sT "$(basename "$2")" "$1"; chown -h --reference="$2" "$1"; }
# Whether $1 is a link that resolves to $2, a real folder.
links_to() { [[ -L $1 && -d $2 && ! -L $2 && $(readlink -f "$1") == "$(readlink -f "$2")" ]]; }

exec 8>"$top/run/lock/temp-code-update.lock"
flock -n 8 || { echo 'ERROR: a box update or history import holds the maintenance lock; run this after it ends' >&2; exit 1; }
exec 9>"$top/run/lock/box-backup.lock"
flock -n 9 || { echo 'ERROR: a backup or restore drill holds the backup lock; run this after it ends' >&2; exit 1; }

# What a pair is going forward: moved (the old name links to the new folder),
# move, back (move, once the link --undo left at the new name is gone), link (a
# run stopped between its rename and its link), absent, or why not.
forward_state() {
  local old=$1 new=$2
  if links_to "$old" "$new"; then echo moved
  elif [[ -L $old ]]; then echo "refuse: $old is a link to $(readlink "$old"), not to $new"
  elif [[ -L $new ]] && ! links_to "$new" "$old"; then echo "refuse: $new is a link to $(readlink "$new"), not to $old"
  elif [[ -d $old ]]; then
    if mountpoint -q "$old"; then echo "refuse: $old is a mount point, which cannot be renamed"
    elif [[ -L $new ]]; then echo back
    elif [[ -e $new ]]; then echo "refuse: $old and $new are both real; nothing is merged, so move one aside by hand"
    else echo move; fi
  elif [[ -e $old ]]; then echo "refuse: $old is not a folder"
  elif [[ -d $new ]]; then echo link
  elif [[ -e $new ]]; then echo "refuse: $new is not a folder"
  else echo absent; fi
}
# And back, to the old name with a link at the new one, which keeps every path
# recorded by the new name meanwhile (git's worktrees, box-update's records):
# undone, undo, unlinked (a run stopped between dropping the old link and its
# rename), relink (stopped after its rename, or never moved), absent, or why not.
undo_state() {
  local old=$1 new=$2
  if links_to "$new" "$old"; then echo undone
  elif links_to "$old" "$new"; then echo undo
  elif [[ -L $old ]]; then echo "refuse: $old is a link to $(readlink "$old"), not to $new"
  elif [[ -L $new ]]; then echo "refuse: $new is a link to $(readlink "$new"), not to $old"
  elif [[ -d $old ]]; then
    if [[ -e $new ]]; then echo "refuse: $old and $new are both real; nothing is merged, so move one aside by hand"
    else echo relink; fi
  elif [[ -e $old ]]; then echo "refuse: $old is not a folder"
  elif [[ -d $new ]]; then echo unlinked
  elif [[ -e $new ]]; then echo "refuse: $new is not a folder"
  else echo absent; fi
}

states=()
for i in "${!olds[@]}"; do
  if ((undo)); then state=$(undo_state "${olds[$i]}" "${news[$i]}"); else state=$(forward_state "${olds[$i]}" "${news[$i]}"); fi
  [[ $state != refuse:* ]] || die "${state#refuse: }. Nothing was changed."
  states+=("$state")
done

if systemctl is-active --quiet "$unit"; then
  ((stop)) || die "$unit is running. Stop it first, or pass --stop-service to stop it, move, and start it again."
  say "stopped $unit"
  ((dry)) || { systemctl stop "$unit"; stopped=1; }
fi

# Before the folders move, while $here (a build's own folder) has its path.
if ((!undo)); then
  # The service's Electron will run from docket-builds, and AppArmor matches the real path.
  if [[ -f $apparmor ]] && ! grep -q 'docket-builds/\*' "$apparmor"; then
    say "let AppArmor's temp-code profile cover docket-builds"
    ((dry)) || { sed -i 's#temp-code-builds/\*}#temp-code-builds/*,docket-builds/*}#' "$apparmor"; apparmor_parser -r "$apparmor"; }
  fi
  if [[ -f $excludes ]]; then
    for path in /srv/agents/docket-builds '/srv/agents/docket-data/*.db' '/srv/agents/docket-data/*.db-wal' \
      '/srv/agents/docket-data/*.db-shm' /srv/agents/docket-data/blob_storage /srv/agents/docket-data/Crashpad \
      /srv/agents/docket-data/work-files/previews /srv/agents/docket-data/work-files/preview-scratch; do
      grep -qxF "$path" "$excludes" && continue
      say "excluded $path from restic"
      ((dry)) || printf '%s\n' "$path" >> "$excludes"
    done
  fi
  for tool in box-update:box-update.sh:755 box-sqlite-snapshot:sqlite-snapshot.sh:750; do
    IFS=: read -r name source mode <<< "$tool"
    installed=$top/usr/local/sbin/$name
    [[ -f $here/$source && -f $installed ]] || continue
    cmp -s "$here/$source" "$installed" && continue
    say "installed $name from $here"
    ((dry)) || install -m "$mode" "$here/$source" "$installed"
  done
fi

# --undo: each database takes its old name back before its folder does. The
# WAL is emptied into the file first, so one rename carries all of it.
undo_db() {
  local dir=$1 old new side
  for pair in 'temp-code.db docket.db' 'temp-code-cold.db docket-cold.db'; do
    read -r old new <<< "$pair"
    [[ -f $dir/$new && ! -L $dir/$new ]] || continue
    if [[ -e $dir/$old || -L $dir/$old ]] && ! [[ $dir/$old -ef $dir/$new ]]; then
      die "$dir holds both $old and $new as separate databases; nothing is merged, and nothing more was changed."
    fi
    for side in -journal -wal; do
      if [[ -f $dir/$old$side && ! -L $dir/$old$side ]]; then
        die "$dir/$old$side is left from an unfinished move; start the app once to finish it, then undo. Nothing more was changed."
      fi
    done
    say "named $new $old again in $dir"
    ((dry)) && continue
    as_owner "$dir/$new" python3 - "$dir/$new" <<'PY'
import sqlite3, sys
db = sqlite3.connect(sys.argv[1])
if db.execute('PRAGMA wal_checkpoint(TRUNCATE)').fetchone()[0]:
    raise SystemExit(f'{sys.argv[1]}: its WAL could not be emptied; something still has it open')
db.close()
PY
    for side in -shm -journal -wal; do
      if [[ -e $dir/$new$side ]]; then rename "$dir/$new$side" "$dir/$old$side"; fi
    done
    if [[ -L $dir/$old || ! -e $dir/$old ]]; then rename "$dir/$new" "$dir/$old"; else rm -- "$dir/$new"; fi
  done
}

for i in "${!olds[@]}"; do
  old=${olds[$i]} new=${news[$i]} state=${states[$i]}
  case $state in
    moved) echo "ALREADY: $old is a link to $new" ;;
    undone) echo "ALREADY: $old is the real folder, and $new a link to it" ;;
    absent) echo "SKIP: neither $old nor $new exists" ;;
    back)
      say "removed the link $new that --undo left"
      ((dry)) || rm -- "$new"
      ;&
    move)
      say "moved $old to $new"
      ((dry)) || rename "$old" "$new"
      ;&
    link)
      say "linked $old to $new"
      ((dry)) || link "$old" "$new"
      ;;
    undo)
      if ((i == 0)); then undo_db "$new"; fi
      say "removed the link $old"
      ((dry)) || rm -- "$old"
      ;&
    unlinked)
      if ((i == 0)) && [[ $state == unlinked ]]; then undo_db "$new"; fi
      say "moved $new back to $old"
      ((dry)) || rename "$new" "$old"
      ;&
    relink)
      if ((i == 0)) && [[ $state == relink ]]; then undo_db "$old"; fi
      say "linked $new to $old"
      ((dry)) || link "$new" "$old"
      ;;
  esac
done
# Folders undone before still get their databases back.
if ((undo)) && [[ ${states[0]} == undone ]]; then undo_db "${olds[0]}"; fi

if ((stopped)); then
  systemctl start "$unit"
  stopped=0
  echo "DONE: started $unit"
  if [[ -z $top ]] && ((!undo)); then
    echo 'The app names its databases as it starts; its lines (up to a minute):'
    for _ in $(seq 30); do
      lines=$(journalctl -u "$unit" --since '-2min' --no-pager -o cat 2>/dev/null | grep -F '[boot] data' || true)
      [[ -z $lines ]] || { echo "$lines"; break; }
      sleep 2
    done
  fi
elif ((stop && dry)) && systemctl is-active --quiet "$unit"; then echo "WOULD: start $unit again"
fi
