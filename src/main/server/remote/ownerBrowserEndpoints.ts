import type { BrowserEndpoints } from '@shared/browserEndpoints'

export const BROWSER_ENDPOINT_ACK_MS = 3_000
export const BROWSER_INPUT_PROOF_MS = 1_500

/** Publish owner routes only after peers can fence them. The native peer sockets stay open. */
export class OwnerBrowserEndpoints {
  current: BrowserEndpoints | undefined
  private revision = 0

  invalidate(): void {
    this.current = undefined
    this.revision++
  }

  async publish(endpoints: BrowserEndpoints, hasPeers: boolean, announce: () => Promise<boolean>[]): Promise<void> {
    this.invalidate()
    const revision = this.revision
    if (hasPeers) {
      const answered = new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, BROWSER_ENDPOINT_ACK_MS)
        void Promise.allSettled(announce()).then((answers) => {
          if (answers.every((answer) => answer.status === 'fulfilled' && answer.value)) {
            clearTimeout(timer)
            resolve()
          }
        })
      })
      // Even if every peer answers, let any proof issued before the move expire.
      await Promise.all([new Promise<void>((resolve) => setTimeout(resolve, BROWSER_INPUT_PROOF_MS)), answered])
    }
    if (this.revision === revision) this.current = endpoints
  }
}
