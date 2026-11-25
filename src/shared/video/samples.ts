/** Recent samples for one stream, kept small enough to sort only when read. */
export class VideoSamples {
  private readonly values: number[] = []

  add(ms: number): void {
    if (this.values.length === 120) this.values.shift()
    this.values.push(ms)
  }

  median(): number | undefined {
    const sorted = [...this.values].sort((a, b) => a - b)
    const middle = Math.floor(sorted.length / 2)
    if (!sorted.length) return undefined
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
  }

  clear(): void {
    this.values.length = 0
  }
}
