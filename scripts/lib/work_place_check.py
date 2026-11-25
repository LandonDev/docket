"""A Work place's ready file, held to what its shot needs (scripts/ios-sim-proof.sh `place_shot`, the proof parts
m2 to m5).

    python3 scripts/lib/work_place_check.py <place report> <shot> <least rows> [failed]

The report is the app's Documents/place-<place>.json as `TestHooks.recordPlaceLoaded` wrote it once the place's
list had its first answer: `rows` (the rows on the list) and `failed` (1 when the read failed and the list shows its
failure line). PASS when the list holds at least <least rows> rows and its read did not fail; with `failed`, when
the read failed (a place the test server cannot answer, shot for its failure line). One line either way; exit 1 on
a FAIL, 2 when the report is missing or unreadable.
"""
import json
import sys


def check(report, least, want_failed):
    """The failure's words, or None when the report is what the shot needs."""
    rows, failed = report.get('rows'), report.get('failed')
    if not isinstance(rows, int) or failed not in (0, 1):
        return f'the report is not a place report: {json.dumps(report)}'
    if want_failed:
        return None if failed == 1 else f'the read was meant to fail and did not ({rows} rows)'
    if failed == 1:
        return f'the read failed ({rows} rows kept)'
    if rows < least:
        return f'{rows} rows, at least {least} wanted'
    return None


def main(argv):
    if len(argv) not in (4, 5) or (len(argv) == 5 and argv[4] != 'failed'):
        print('usage: work_place_check.py <place report> <shot> <least rows> [failed]', file=sys.stderr)
        return 2
    path, shot, least = argv[1], argv[2], int(argv[3])
    try:
        with open(path) as f:
            report = json.load(f)
    except (OSError, ValueError) as err:
        print(f'WORK PLACE FAIL ({shot}) no report: {err}')
        return 2
    wrong = check(report, least, len(argv) == 5)
    if wrong:
        print(f'WORK PLACE FAIL ({shot}) {wrong}')
        return 1
    print(f'work place {shot} PASS ({report["rows"]} rows{", failed as meant" if report["failed"] else ""})')
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
