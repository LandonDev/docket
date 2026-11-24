import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseProofLine, redProofsNotice } from '../src/shared/releasePhases'

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

  it('makes the Windows files by default, only after the Mac release is live, and never fails on them', () => {
    expect(code).toMatch(/^WIN=\$\{TEMP_CODE_WIN:-1\}$/m)
    expect(code).toContain('--no-win) WIN=0 ;;')
    // nothing of Windows before the total line: no pack, no upload, no feed wait
    expect(code).not.toContain('electron-builder --win')
    expect(code).not.toContain('setup.exe')
    expect(code).not.toContain('feed_version latest.yml')
    const pass = code.slice(at('windows_pass() {'), code.indexOf('\n}\n', at('windows_pass() {')))
    expect(pass).toContain('echo "phase – windows skipped (--no-win)"')
    for (const call of pass.split('\n').filter((line) => line.includes('release-publish-win.sh'))) {
      for (const run of call.split(/; (?:else|then) /).filter((part) => part.includes('release-publish-win.sh'))) expect(run).toMatch(/--built.* \|\| true/)
    }
    // in a dry run and a real one alike: after the total line, before the proofs
    for (const total of [code.indexOf(TOTAL), code.lastIndexOf(TOTAL)]) {
      const windows = code.indexOf('windows_pass\n', total)
      expect(windows).toBeGreaterThan(total)
      expect(code.indexOf('run_proofs\n', total)).toBeGreaterThan(windows)
    }
  })
})

describe('release-publish-win.sh', () => {
  const win = readFileSync(resolve(__dirname, 'release-publish-win.sh'), 'utf8')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n')

  it("says a failure in one proof line, which the app reads as a notice beside the live release", () => {
    expect(win).toContain('echo "proof ✗ windows $1, log $LOG"')
    const row = parseProofLine('proof ✗ windows not built: cargo-xwin is missing, log /r/.git/temp-code-gate/windows.log')
    expect(row).toEqual({ row: 'windows', outcome: 'failed', note: 'not built: cargo-xwin is missing', log: '/r/.git/temp-code-gate/windows.log' })
    expect(redProofsNotice('1.0.367', [row!])).toBe(
      'The proofs after v1.0.367 are red: windows (not built: cargo-xwin is missing, log /r/.git/temp-code-gate/windows.log). The release stays live.'
    )
  })

  it("adds files only to a published release, from that release's own tag, and uploads nothing on a dry run", () => {
    expect(win).toContain('fail "v$VERSION is not a published release"')
    expect(win).toContain('[ "$(git rev-parse -q --verify "v$VERSION^{commit}")" = "$SHA" ]')
    expect(win).not.toMatch(/gh release (create|delete)|--draft/)
    const dry = win.indexOf('if [ "$DRY" = 1 ]; then\n  echo "phase ✓ windows')
    expect(dry).toBeGreaterThan(-1)
    expect(win.indexOf('exit 0', dry)).toBeLessThan(win.indexOf('gh release upload'))
  })

  it('reads Latest before and after the upload and puts it back if it moved', () => {
    const before = win.indexOf('LATEST=$(gh api "repos/$REPO/releases/latest"')
    const upload = win.indexOf('gh release upload')
    const after = win.indexOf('AFTER=$(gh api "repos/$REPO/releases/latest"')
    expect(before).toBeGreaterThan(-1)
    expect(before).toBeLessThan(upload)
    expect(after).toBeGreaterThan(upload)
    expect(win).toContain('gh release edit "$LATEST" --repo "$REPO" --latest')
  })
})
