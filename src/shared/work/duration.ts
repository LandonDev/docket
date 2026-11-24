/** Work's one duration form (docs/DESIGN.md "Type scale", one name a thing): "38 min", "1 hr", "1 hr 10 min". */
export function durationOf(minutes: number): string {
  const m = Math.max(0, Math.round(minutes))
  if (m < 60) return `${m} min`
  return m % 60 ? `${Math.floor(m / 60)} hr ${m % 60} min` : `${m / 60} hr`
}
