#!/usr/bin/env python3
"""Judges the iPhone's Work performance proof (scripts/ios-sim-proof.sh `work_perf_set`).

    ios_work_perf_check.py [--gates FILE] DIR [DIR ...]

Each DIR holds one pass: launch-today.json has the cold launch splits.
rest-today.json has the rest split and its quiet-window counts and CPU.
list-idle.json and list-busy.json have the list check's `list` split (its
row counts, the app's scrolls under the finger, and the frames, reported).
editor.json has the `open` split with the app's memory, and
editor-webkit.json the WebKit processes' peak the script sampled. All but
the last use the app's WorkPerfFile shape.

Counts must hold in every pass. Launch times use the best pass. Rest CPU
reports milliseconds per second for each pass. The gates file says which
targets can fail the check. A missing run, missing split, noted split, or
missing rest data fails any enabled gate that needs it. The simulator cannot
make the locked split. Exit 0 when the enabled gates hold, 5 when one fails,
or 2 when no pass directory is given.
"""
import json
import os
import sys

LAUNCH_RUN = 'launch-today'
REST_RUN = 'rest-today'
LIST_RUNS = ['list-idle', 'list-busy']
EDITOR_RUN = 'editor'
# The editor run's ceilings in megabytes: the app alone, and the app with its WebKit processes.
APP_CEILING_MB = 300
TOTAL_CEILING_MB = 700
# The splits the simulator makes; `locked` needs a phone behind its lock with the cache under complete protection.
SPLITS = ['empty', 'cached', 'restored']
NOT_RUN = {'locked': 'the simulator cannot lock the phone'}
# Cold launch times are in milliseconds. Rest CPU is in milliseconds per second.
BUDGET_MS = 400
REST_CPU_BUDGET = 10


def load_pass(directory, run):
    path = os.path.join(directory, run + '.json')
    if not os.path.exists(path):
        return {}
    with open(path) as handle:
        return json.load(handle).get('splits', {})


def load_json(directory, name):
    path = os.path.join(directory, name)
    if not os.path.exists(path):
        return None
    with open(path) as handle:
        return json.load(handle)


class Judge:
    def __init__(self, gates, passes, rest_passes, list_passes=None, editor_passes=None):
        self.gates = gates
        self.passes = passes
        self.rest_passes = rest_passes
        # Per pass: {run: list report or None}; per pass: (open split or None, webkit sample or None).
        self.list_passes = list_passes or []
        self.editor_passes = editor_passes or []
        self.failed = []
        self.lines = []

    def gate(self, name, problems, facts):
        on = self.gates.get(name, False)
        verdict = 'PASS' if not problems else ('FAIL' if on else 'miss')
        self.lines.append(f"{name:21} {'on ' if on else 'off'} {verdict}  {facts}")
        for problem in problems:
            self.lines.append(f"{'':21}     {problem}")
        if on and problems:
            self.failed.append(name)

    def measured(self, split):
        return [p[split] for p in self.passes if split in p and not p[split].get('note')]

    def need(self, splits):
        return [f'{s}: {len(self.measured(s))} of {len(self.passes)} passes measured'
                for s in splits if len(self.measured(s)) < len(self.passes)]

    def judge(self):
        self.network_before_frame()
        self.rows_remade()
        for name, key in (('first-frame', 'firstFrameMs'), ('cached-row', 'cachedRowMs'), ('row-hit', 'rowHitMs')):
            self.time(name, key)
        self.rest('rest-ticks', 'ticks', 'ticksAllowed')
        self.rest('rest-queries', 'queries', 'queriesAllowed')
        self.rest('rest-polls', 'reads', 0)
        self.rest('rest-cpu', 'mainCpuMs', REST_CPU_BUDGET)
        self.lists()
        self.editor()

    def list_reports(self, problems):
        """Each list run's report in each pass; a missing or noted one is a problem."""
        found = []
        for index, runs in enumerate(self.list_passes, 1):
            for run in LIST_RUNS:
                report = runs.get(run)
                if report is None:
                    problems.append(f'pass {index} {run}: no list report')
                elif report.get('note'):
                    problems.append(f"pass {index} {run}: {report['note']}")
                else:
                    found.append((index, run, report))
        return found

    def lists(self):
        built, remade, offsets = [], [], []
        built_facts, remade_facts, offset_facts = [], [], []
        for problems, facts, judge in ((built, built_facts, 'built'), (remade, remade_facts, 'remade'), (offsets, offset_facts, 'offsets')):
            for index, run, r in self.list_reports(problems):
                limit = r.get('window', 0) * 2
                tag = f'pass {index} {run}'
                if judge == 'built':
                    facts.append(f"{tag} {r.get('firstPaintMade', 0)}/{r.get('peakAlive', 0)} of {limit}")
                    if r.get('window', 0) <= 0:
                        problems.append(f'{tag}: the list showed no rows')
                    if r.get('firstPaintMade', 0) > limit:
                        problems.append(f"{tag}: {r['firstPaintMade']} rows built before the scroll ({limit})")
                    if r.get('peakAlive', 0) > limit:
                        problems.append(f"{tag}: {r['peakAlive']} rows alive at once ({limit})")
                elif judge == 'remade':
                    # SwiftUI's List drops a row's state once it scrolls far off, so a row built again by the scroll is
                    # reported, never judged; what counts is a row built while the list stood still, which only a push
                    # for another place could have thrown away (m6-speed-access.md).
                    facts.append(f"{tag} again {r.get('madeAgain', 0)}, still {r.get('stillMade', 0)} over {r.get('stillPushes', 0)} pushes")
                    if r.get('stillMade', 0):
                        problems.append(f"{tag}: {r['stillMade']} rows built while the list stood still")
                    if run == 'list-busy' and not r.get('stillPushes', 0):
                        problems.append(f'{tag}: no push for another place arrived in the still seconds, so nothing was judged')
                else:
                    facts.append(f"{tag} {r.get('offsetWrites', 0)}")
                    if r.get('offsetWrites', 0):
                        problems.append(f"{tag}: {r['offsetWrites']} scrolls the app made under the finger (0)")
        self.gate('list-rows-built', built, 'first/peak of limit: ' + ', '.join(built_facts))
        self.gate('list-rows-remade', remade, ', '.join(remade_facts))
        self.gate('list-offset-writes', offsets, ', '.join(offset_facts))

    def editor(self):
        problems, facts = [], []
        for index, (split, webkit) in enumerate(self.editor_passes, 1):
            memory = (split or {}).get('memory')
            if not split or split.get('note') or not memory:
                problems.append(f'pass {index}: no editor measurement' + (f" ({split['note']})" if split and split.get('note') else ''))
                continue
            app = memory.get('peakMB', 0)
            web = (webkit or {}).get('peakMB')
            total = app + (web or 0)
            facts.append(f"pass {index}: app {app:g}/{APP_CEILING_MB} MB, with WebKit {total:g}/{TOTAL_CEILING_MB} MB")
            if not memory.get('webLoads'):
                problems.append(f'pass {index}: no hosted page loaded, so no editor was up')
            if web is None:
                problems.append(f'pass {index}: the WebKit processes were not sampled')
            if app > APP_CEILING_MB:
                problems.append(f'pass {index}: the app peaked at {app:g} MB ({APP_CEILING_MB})')
            if total > TOTAL_CEILING_MB:
                problems.append(f'pass {index}: the app and WebKit peaked at {total:g} MB ({TOTAL_CEILING_MB})')
        self.gate('editor-memory', problems, ', '.join(facts))

    def rest(self, name, key, limit):
        problems = []
        facts = []
        for index, splits in enumerate(self.rest_passes, 1):
            report = splits.get('rest') or {}
            data = report.get('rest') or {}
            value = data.get(key)
            allowed = data.get(limit) if isinstance(limit, str) else limit
            unit = ''
            if key == 'mainCpuMs':
                seconds = data.get('seconds')
                value = value / seconds if value is not None and seconds and seconds > 0 else None
                unit = ' ms/s'
            if report.get('note') or value is None or allowed is None:
                problems.append(f'pass {index}: no rest measurement for {key}')
                continue
            fact = f'pass {index}: {value:g}/{allowed:g}{unit}'
            facts.append(fact)
            if (value != allowed if key == 'reads' else value > allowed):
                problems.append(fact + ' missed the target')
        self.gate(name, problems, ', '.join(facts))

    def network_before_frame(self):
        problems = self.need(SPLITS)
        facts = []
        for split in SPLITS:
            for report in self.measured(split):
                count = report.get('marks', {}).get('requestsBeforeFirstFrame')
                facts.append(f'{split} {count}')
                if not report.get('counted') or count is None:
                    problems.append(f'{split}: this build does not count the socket\'s requests (a Release build?)')
                elif count:
                    problems.append(f'{split}: {count} requests began before the first frame (0)')
        self.gate('network-before-frame', problems, ', '.join(facts))

    def rows_remade(self):
        problems = self.need(['cached'])
        facts = []
        for split in SPLITS:
            for report in self.measured(split):
                made, remade, changed = report.get('rowsMade', 0), report.get('rowsRemade', 0), report.get('rowsRemadeChanged', 0)
                facts.append(f'{split} {remade}/{changed}/{made}')
                if split != 'cached':
                    continue
                if not made:
                    problems.append('cached: no Today row was made, so nothing was judged')
                elif remade:
                    problems.append(f"cached: the fresh list made {remade} unchanged rows again ({', '.join(report.get('remade', []))})")
        self.gate('rows-remade', problems, 'remade/changed/made: ' + ', '.join(facts))

    def time(self, name, key):
        problems = self.need(['cached'])
        values = [r.get('marks', {}).get(key) for r in self.measured('cached')]
        best = min((v for v in values if v is not None), default=None)
        if best is None:
            problems.append(f'cached: no pass marked {key}')
        elif best > BUDGET_MS:
            problems.append(f'cached: {key} {best} ms from the process start ({BUDGET_MS})')
        self.gate(name, problems, f'cached best {best} ms')


def table(passes, names):
    lines = ['split     pass  frame   row  cached  hit  req  made remade cpu  note']
    for split in names:
        for index, splits in enumerate(passes):
            r = splits.get(split)
            if r is None:
                lines.append(f'{split:9} {index + 1:>4}  ' + ('not run (' + NOT_RUN[split] + ')' if split in NOT_RUN else 'missing'))
                continue
            m = r.get('marks', {})
            cell = lambda k: m.get(k) if m.get(k) is not None else '-'
            req = m.get('requestsBeforeFirstFrame')
            lines.append(
                f"{split:9} {index + 1:>4} {cell('firstFrameMs'):>6} {cell('firstRowMs'):>5} {cell('cachedRowMs'):>7} {cell('rowHitMs'):>4} "
                f"{req if req is not None else '-':>4} {r.get('rowsMade', 0):>5} {r.get('rowsRemade', 0):>6} {r.get('cpuMs', 0):>4}  {r.get('note') or ''}"
            )
    return lines


def list_table(list_passes):
    lines = ['run       pass  window first peak again still/pushes offsets late  p95  worst hitch main  thermal']
    for index, runs in enumerate(list_passes, 1):
        for run in LIST_RUNS:
            r = runs.get(run)
            if r is None:
                lines.append(f'{run:9} {index:>4}  missing')
                continue
            if r.get('note'):
                lines.append(f"{run:9} {index:>4}  {r['note']}")
                continue
            lines.append(
                f"{run:9} {index:>4} {r.get('window', 0):>7} {r.get('firstPaintMade', 0):>5} {r.get('peakAlive', 0):>4} {r.get('madeAgain', 0):>5}"
                f" {r.get('stillMade', 0):>5}/{r.get('stillPushes', 0):<6} {r.get('offsetWrites', 0):>7} {r.get('late', 0):>4}/{r.get('frames', 0):<5}"
                f" {r.get('frameP95Ms', 0):>4} {r.get('frameWorstMs', 0):>6} {r.get('hitchMsPerS', 0):>5} {r.get('mainP95Ms', 0):>4}  {r.get('thermal', '')}"
            )
    return lines


def main(argv):
    gates_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'ios_work_perf_gates.json')
    directories = []
    index = 0
    while index < len(argv):
        if argv[index] == '--gates':
            index += 1
            gates_path = argv[index]
        else:
            directories.append(argv[index])
        index += 1
    if not directories:
        print(__doc__, file=sys.stderr)
        return 2
    with open(gates_path) as handle:
        gates = json.load(handle)
    passes = [load_pass(d, LAUNCH_RUN) for d in directories]
    rest_passes = [load_pass(d, REST_RUN) for d in directories]
    list_passes = [{run: load_pass(d, run).get('list', {}).get('list') for run in LIST_RUNS} for d in directories]
    editor_passes = [(load_pass(d, EDITOR_RUN).get('open'), load_json(d, 'editor-webkit.json')) for d in directories]
    judge = Judge(gates, passes, rest_passes, list_passes, editor_passes)
    judge.judge()
    for run, reports, names in ((LAUNCH_RUN, passes, SPLITS + list(NOT_RUN)), (REST_RUN, rest_passes, ['rest'])):
        for line in table(reports, names):
            print(f'ios-work-perf: {run} ' + line)
    for line in list_table(list_passes):
        print('ios-work-perf: list ' + line)
    for line in judge.lines:
        print('ios-work-perf-gate: ' + line)
    if judge.failed:
        print('ios-work-perf-check: FAIL ' + ', '.join(judge.failed), file=sys.stderr)
        return 5
    print('ios-work-perf-check: PASS (' + str(sum(1 for on in gates.values() if on)) + ' gates on)')
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
