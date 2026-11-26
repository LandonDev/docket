/**
 * The renderer soak's `--link` (scripts/measure-renderer-soak.ts): the window reaches the synthetic host
 * through a relay, for every scene that pairs with it by a remote key. Two forms:
 *
 *   --link 512          the old form: the host gives the window 512 KiB a second, nothing else
 *                       (slowLink, the reconnect scene's relay that reports what it held)
 *   --link 60/10        the perf kit's form: 60 ms there and back, 10 Mbit a second each way
 *                       (startSlowLink, scripts/lib/slowLink.ts, as `bun run perf` shapes its pair)
 *   --link 60/10/<part> a part after the rate is looked up in LINK_PARTS by its letters; what it answers
 *                       rides into startSlowLink's options as they are, so a new option (the jitter's `j8`)
 *                       is one line there.
 *
 * Pure, so scripts/soak-link.test.ts reads the forms.
 */

export type SoakLink =
  | { form: 'kib'; bytesPerSec: number; words: string }
  | {
      form: 'shape'
      /** one way, half the round trip: startSlowLink's `delayMs` */
      delayMs: number
      rateMbit: number
      /** more of startSlowLink's options, spread in as they are */
      options: Record<string, unknown>
      words: string
    }

/** A part after the rate: its letters → the options it adds, from the number after them. */
export const LINK_PARTS: Record<string, (n: number) => Record<string, unknown>> = {}

export function parseSoakLink(value: string): SoakLink {
  if (/^\d+(\.\d+)?$/.test(value)) {
    const kib = Number(value)
    if (!(kib > 0)) throw new Error('--link takes KiB a second above 0, or <ms there and back>/<Mbit a second>')
    return { form: 'kib', bytesPerSec: Math.round(kib * 1024), words: `${kib} KiB/s from the host` }
  }
  const [rtt, rate, ...rest] = value.split('/')
  const rttMs = Number(rtt)
  const rateMbit = Number(rate)
  if (!/^\d+(\.\d+)?$/.test(rtt ?? '') || !/^\d+(\.\d+)?$/.test(rate ?? '') || !(rateMbit > 0)) {
    throw new Error(`--link ${value}: give KiB a second (512) or <ms there and back>/<Mbit a second> (60/10)`)
  }
  const options: Record<string, unknown> = {}
  for (const part of rest) {
    const m = /^([a-z]+)(\d+(?:\.\d+)?)$/.exec(part)
    const make = m ? LINK_PARTS[m[1]!] : undefined
    if (!m || !make) throw new Error(`--link ${value}: no part "${part}" is known (LINK_PARTS in scripts/lib/soakLink.ts)`)
    Object.assign(options, make(Number(m[2])))
  }
  return { form: 'shape', delayMs: rttMs / 2, rateMbit, options, words: `${rttMs} ms there and back at ${rateMbit} Mbit/s${rest.length ? ` (${rest.join(', ')})` : ''}` }
}
