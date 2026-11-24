type Frame = { id?: string; method?: string; params?: { source?: { path?: string } }; ok?: boolean; error?: string; result?: { opened?: boolean } }

export class AppOpenProof {
  private readonly pending = new Set<string>()
  private path: string | undefined
  answer?: { opened: boolean; error?: string }

  watch(path: string): void {
    this.path = path
    this.pending.clear()
    this.answer = undefined
  }

  frame(socket: string, sent: boolean, frame: Frame): void {
    if (!frame.id || !this.path) return
    const key = socket + ':' + frame.id
    if (sent) {
      if (frame.method === 'work.office.filesOpen' && frame.params?.source?.path === this.path) this.pending.add(key)
      return
    }
    if (!this.pending.delete(key)) return
    this.answer = {
      opened: frame.ok === true && frame.result?.opened === true,
      ...(frame.error ? { error: frame.error } : {})
    }
  }
}
