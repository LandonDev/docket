"""The Work fold cycle's check (scripts/ios-sim-proof.sh `duo_work_fold_run`).

    python3 scripts/lib/duo_work_fold_check.py <layout dir> <step> <ordinary|wide> [shown|hidden] [typed]

A step is one Work screen taken folded, unfolded and folded again with the app running. Reads
<layout dir>/{folded,unfolded}/wfold-<step>-<n>-<pose>.json (stops 1 folded, 2 unfolded, 3 folded) and
<layout dir>/wfold-<step>/{events.json,row-inits.json}; writes wfold-<step>/report.json. The route is
`ordinary` or `wide` (ShellPaths.wide: the sidebar put away); the last argument is his own press on the
sidebar button over a wide route, when the run made one; `typed` says the run typed a draft and put a chip in the
box, so the first stop must hold both.

Held at every stop (docs/IOS-DESIGN.md "Work in every pose"): the typed route (`work.route`), the picked
row (`work.picked`), the list's top row (`work.top`), the draft's length (`draftChars`), the chips in a Work
thread's box (`work.chips`) and an open sheet (`work.sheet`) as at the first stop; his chosen visibility (`sidebar.chosen`) never changed by a fold; the
effective visibility (`sidebar`) one of the states allowed for the route and the pose; no row on screen
made its state twice (`row-inits.json`); the hosted web view the same object (`web.instance`) with its
load count (`web.loads`) not grown. One line a failure; exit 1 on any.
"""
import json
import pathlib
import sys

STOPS = [('folded', 1), ('unfolded', 2), ('folded', 3)]
# The shell's sidebar by the pose LayoutProbe classified: collapsed, tiled beside the detail, or over it.
# Every regular pose tiles (`ShellPose.of`, the split's balanced style): upright too, as iOS 27.1 draws it (iw13).
SHAPES = {'folded': 'stack', 'folded-landscape': 'stack', 'unfolded': 'tiled', 'half-open': 'tiled', 'unfolded-portrait': 'tiled', 'tabletop': 'tiled'}


def allowed(shape, route, chosen, override):
    """The effective visibility the route, the pose and his choices allow (`SidebarVisibility.shown`)."""
    if shape == 'stack':
        return 'stack'
    shown = (override == 'shown') if route == 'wide' else (chosen == 'shown')
    if not shown:
        return 'hidden'
    return 'visible' if shape == 'tiled' else 'overlay'


def check(out, step, route, override=None, typed=False):
    d = out / f'wfold-{step}'
    reports = [json.loads((out / p / f'wfold-{step}-{i}-{p}.json').read_text()) for p, i in STOPS]
    notes = [r.get('notes', {}) for r in reports]
    events = json.loads((d / 'events.json').read_text())
    failures = []

    def held(key, label):
        values = [n.get(key) for n in notes]
        if any(v != values[0] for v in values):
            failures.append(f'{label} changed: {values}')
        return values

    routes = held('work.route', 'route')
    if not routes[0]:
        failures.append('no typed route (work.route) at the first stop')
    held('work.picked', 'picked row')
    held('work.top', 'top row')
    drafts = held('draftChars', 'draft')
    chips = held('work.chips', 'chips')
    if typed:
        if int(drafts[0] or 0) <= 0:
            failures.append(f'no typed draft at the first stop (draftChars {drafts[0]})')
        if int(chips[0] or 0) <= 0:
            failures.append(f'no chip in the box at the first stop (work.chips {chips[0]})')
    # An open sheet stays up: the same at every stop, and never gone between the first stop and the last.
    sheets = held('work.sheet', 'sheet')
    first, last = reports[0].get('t', 0), reports[-1].get('t', 0)
    inside = [e for e in events if first < e.get('t', 0) <= last]
    if sheets[0] not in (None, 'none'):
        closed = [e for e in inside if e.get('key') == 'work.sheet' and e.get('to') == 'none']
        if closed:
            failures.append(f"sheet {sheets[0]} went away at {closed[0]['t']} ms")
    # His own choice: a fold writes no preference.
    chosen = held('sidebar.chosen', 'chosen sidebar')
    writes = [e for e in inside if e.get('key') == 'sidebar.chosen']
    if writes:
        failures.append(f"a fold wrote the chosen sidebar: {[(e['t'], e.get('from'), e.get('to')) for e in writes]}")
    # The sidebar the split shows, stop by stop.
    for (p, i), r, n in zip(STOPS, reports, notes):
        pose = r.get('classified') or p
        want = allowed(SHAPES.get(pose, 'stack'), route, n.get('sidebar.chosen', chosen[0]), override)
        if n.get('sidebar') != want:
            failures.append(f"stop {i} ({pose}): sidebar {n.get('sidebar')}, want {want} ({route} route)")
    # The merged log must reach back past the first stop (the app keeps the newest 500).
    if events and events[0].get('t', 0) > first:
        failures.append(f"the event log starts at {events[0]['t']} ms, after the first stop at {first} ms")
    # The hosted page: one object, loaded once.
    instances = held('web.instance', 'web view instance')
    loads = [n.get('web.loads') for n in notes]
    if instances[0] is not None and any(v != loads[0] for v in loads):
        failures.append(f'the hosted page loaded again: {loads}')
    # No row on screen made its state twice.
    inits = json.loads((d / 'row-inits.json').read_text())
    v = inits.get('violations', [])
    if v:
        failures.append(f'{len(v)} rows on screen made their state again: ' + ', '.join(f"{x['key']}×{x['inits']}" for x in v[:8]))
    summary = {'step': step, 'route': routes[0], 'picked': notes[0].get('work.picked'), 'top': notes[0].get('work.top'), 'draft': drafts[0], 'chips': chips[0], 'sidebars': [n.get('sidebar') for n in notes], 'rows': len(inits.get('rows', {})), 'violations': len(v)}
    (d / 'report.json').write_text(json.dumps({**summary, 'failures': failures}, indent=1))
    return summary, failures


def main():
    out, step, route = pathlib.Path(sys.argv[1]), sys.argv[2], sys.argv[3]
    rest = sys.argv[4:]
    typed = 'typed' in rest
    others = [a for a in rest if a != 'typed']
    override = others[0] if others else None
    if route not in ('ordinary', 'wide') or override not in (None, 'shown', 'hidden') or len(others) > 1:
        print('usage: duo_work_fold_check.py <layout dir> <step> <ordinary|wide> [shown|hidden] [typed]', file=sys.stderr)
        sys.exit(2)
    summary, failures = check(out, step, route, override, typed)
    print('ios-sim-proof: work fold ' + json.dumps(summary))
    if failures:
        for f in failures:
            print(f'ios-sim-proof: WORK FOLD FAIL ({step}) {f}', file=sys.stderr)
        sys.exit(1)
    print(f'ios-sim-proof: work fold {step} PASS (route, pick, top row, draft, chips and sheet kept; the sidebar as allowed; no row made twice; the page not loaded again)')


if __name__ == '__main__':
    main()
