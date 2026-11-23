import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// release-publish.sh's order, read from the script: what stands between a
// commit and the feed, and what runs only after it.
const script = readFileSync(resolve(__dirname, 'release-publish.sh'), 'utf8')
const code = script
  .split('\n')
  .filter((line) => !line.trimStart().startsWith('#'))
  .join('\n')
const at = (text: string): number => {
  const i = code.indexOf(text)
  expect(i, text).toBeGreaterThan(-1)
  return i
}
const TOTAL = 'echo "phase ✓ total $(fmt $(( $(now) - T0 ))) $VERSION"'

describe('release-publish.sh', () => {
  it('runs the publish tier beside the build only with --gated; by default the proofs follow the total line', () => {
    expect(code).toMatch(/^GATED=\$\{TEMP_CODE_GATED:-0\}$/m)
    expect(code).toContain('--gated) GATED=1 ;;')
    const blocking = /^elif \[ "\$GATED" = 1 \]; then\n {2}bg_phase gate [^\n]*bun run gate --tier publish &$/m
    expect(code).toMatch(blocking)
    expect(code).toContain('echo "phase – gate after the release"')
    // the one other gate call is the proofs', and it runs after the feed in a real publish and a dry run alike
    expect(code.match(/bun run gate/g)).toHaveLength(2)
    expect(code).toMatch(/bun run gate --tier publish --after-release="\$PREV"/)
    const real = code.lastIndexOf(TOTAL)
    expect(code.indexOf('run_proofs\n', real)).toBeGreaterThan(real)
    const dry = code.indexOf(TOTAL)
    expect(dry).toBeLessThan(real)
    expect(code.indexOf('run_proofs\n', dry)).toBeLessThan(at('exit 0\nfi'))
  })

  it('never fails a live release on the proofs, and GATE_SKIP skips them too', () => {
    const proofs = code.slice(at('run_proofs() {'), code.indexOf('\n}\n', at('run_proofs() {')))
    expect(proofs).toContain('if [ -n "$GATE_SKIP" ]; then echo "phase – proofs skipped"; return 0; fi')
    expect(proofs).toContain('|| true; } |')
    expect(proofs).toMatch(/grep --line-buffered -E '\^\(phase\|proof\) ' \|\| true$/m)
    // the proofs' base: the last published v1.0.N that HEAD holds, never this one
    expect(proofs).toContain(`git tag --merged HEAD --list 'v1.0.*' --sort=-v:refname | grep -vx "v$VERSION" | head -1`)
  })

  it('uploads to the draft beside the ShipIt check, and leaves draft only once the check and the upload are done', () => {
    const upload = at('bg_phase upload')
    const check = at('begin check')
    expect(upload).toBeLessThan(check)
    const live = at('--draft=false')
    expect(at('wait "$UPLOAD_PID"')).toBeLessThan(live)
    expect(at('refuse "the extracted zip fails Squirrel')).toBeLessThan(live)
    expect(code).toContain('for pid in $GATE_PID $PACK_PID $UPLOAD_PID; do')
  })

  it('reads /Applications only in a real publish', () => {
    const reads = code.split('\n').filter((line) => line.includes('/Applications'))
    expect(reads).toEqual(['[ "$DRY" = 0 ] && [ -d /Applications/TempCode.app ] && REFERENCE=/Applications/TempCode.app'])
  })

  it('reads the feed once a second, for a minute at most, instead of a fixed wait', () => {
    const feed = code.slice(at('begin feed'), code.lastIndexOf(TOTAL))
    expect(feed).not.toMatch(/sleep [2-9]/)
    expect(feed).toContain('sleep 1')
    expect(feed).toContain('[ "$tries" -lt 60 ]')
  })

  it('compiles the ShipIt check once per version of its source', () => {
    expect(code).toContain('SQRL="$SQRL_DIR/sqrlcheck-$(shasum -a 256 scripts/sqrlcheck.swift | cut -c1-16)"')
    expect(code).toMatch(/if \[ -x "\$SQRL" \] \|\| \{/)
  })
})
