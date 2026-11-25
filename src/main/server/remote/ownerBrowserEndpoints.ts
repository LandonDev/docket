import type { BrowserEndpoints } from '@shared/browserEndpoints'

export const BROWSER_ENDPOINT_ACK_MS = 3_000
// The proof sent to native input and the owner socket hold must use the same lifetime.
export const BROWSER_INPUT_PROOF_MS = 1_500

/** Publish owner routes only after peers can fence them. The native peer sockets stay open. */
export class OwnerBrowserEndpoints {
  current: BrowserEndpoints | undefined
  private revision = 0

  invalidate(): void {
    this.current = undefined
    this.revision++
  }

  async publish(
    endpoints: BrowserEndpoints,
    hasPeers: boolean,
    announce: () => Promise<boolean>[]
  ): Promise<void> {
    this.invalidate()
    const revision = this.revision
    // A host's own browser input can also carry a proof for an older route.
    const proofWait = new Promise<void>((resolve) => setTimeout(resolve, BROWSER_INPUT_PROOF_MS))
    const peerWait = hasPeers
      ? new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, BROWSER_ENDPOINT_ACK_MS)
          void Promise.allSettled(announce()).then((answers) => {
            if (answers.every((answer) => answer.status === 'fulfilled' && answer.value)) {
              clearTimeout(timer)
              resolve()
            }
          })
        })
      : Promise.resolve()
    await Promise.all([proofWait, peerWait])
    if (this.revision === revision) this.current = endpoints
  }
}
