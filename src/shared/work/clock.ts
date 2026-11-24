const days = new Map<string, Intl.DateTimeFormat>()

/** The date on the wall clock of `zone` at `at`: '2026-11-23'. */
export function dayOf(zone: string, at: number): string {
  let f = days.get(zone)
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' })
    days.set(zone, f)
  }
  const p = Object.fromEntries(f.formatToParts(at).map((x) => [x.type, x.value])) as Record<string, string>
  return `${p.year}-${p.month}-${p.day}`
}

const clocks = new Map<string, Intl.DateTimeFormat>()

/** A wall time in his zone, with a zone name for a thread or a 24-hour clock for a sheet. */
export function timeIn(zone: string, at: number, style: 'plain' | 'named' | '24-hour' = 'plain'): string {
  const key = `${zone}:${style === '24-hour' ? style : 'plain'}`
  let f = clocks.get(key)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: zone, hour: 'numeric', minute: '2-digit',
      ...(style === '24-hour' ? { hour: '2-digit', hourCycle: 'h23' } : {})
    })
    clocks.set(key, f)
  }
  return style === 'named' ? `${f.format(at)} ${zoneName(zone, at)}` : f.format(at)
}

const names = new Map<string, Intl.DateTimeFormat>()
export function zoneName(zone: string, at: number): string {
  let f = names.get(zone)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'longGeneric' })
    names.set(zone, f)
  }
  const name = f.formatToParts(at).find((part) => part.type === 'timeZoneName')
  return name?.value.replace(/(?<! Standard| Daylight| Summer) Time$/, '') ?? zone
}

const dates = new Map<string, Intl.DateTimeFormat>()
/** "Feb 17", and "Feb 17, 2027" when that is another year than `now`'s, on the wall clock of `zone`. */
export function dateIn(zone: string, at: number, now = at): string {
  const year = now !== at && dayOf(zone, at).slice(0, 4) !== dayOf(zone, now).slice(0, 4)
  const key = `${zone}:${year}`
  let f = dates.get(key)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: zone, month: 'short', day: 'numeric', ...(year ? { year: 'numeric' } : {}) })
    dates.set(key, f)
  }
  return f.format(at)
}
