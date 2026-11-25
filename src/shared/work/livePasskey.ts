/**
 * A live Office guest has no passkey sheet: Electron shows none, so a WebAuthn ask never settles and Microsoft's
 * "passkey unlock" spins for good. The guest runs with Blink's `WebAuth` off (`PublicKeyCredential` is gone), and
 * this, run in the page's own world before its scripts (src/preload/livePasskey.ts), makes a passkey ask refuse at
 * once with NotAllowedError, so Microsoft offers Authenticator or the password. Any other credential ask is the
 * browser's as before. Self-contained: it is serialized into the page.
 */
export function refusePasskeys(root: { CredentialsContainer?: { prototype: Record<string, unknown> }; DOMException: typeof DOMException } = globalThis as never): void {
  const proto = root.CredentialsContainer?.prototype
  if (!proto) return
  for (const name of ['get', 'create']) {
    const own = proto[name] as ((this: unknown, options?: { publicKey?: unknown }) => Promise<unknown>) | undefined
    if (typeof own !== 'function') continue
    proto[name] = function (this: unknown, options?: { publicKey?: unknown }): Promise<unknown> {
      if (options && options.publicKey) return Promise.reject(new root.DOMException('Passkeys are not available here.', 'NotAllowedError'))
      return own.call(this, options)
    }
  }
}
