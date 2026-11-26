/**
 * One restart of the fixed port in two steps (index.ts `restartRemote`): the listener goes up (or stays off), then
 * this host's browser endpoints are published once older proofs have expired (ownerBrowserEndpoints.ts, a fixed
 * 1.5 s). Restarts run one after another, each after the last one's publish, as they always have. The boot waits
 * for `listening` alone: until `published` settles the endpoints read undefined, as they do during any restart, so
 * the fence is the same while the rest of the boot goes on.
 */
export interface RemoteRestart {
  listening: Promise<void>
  published: Promise<void>
}

export function chainRestart(previous: Promise<void>, listen: () => Promise<void>, publish: () => Promise<void>): RemoteRestart {
  const listening = previous.then(listen)
  const published = listening.then(publish)
  return { listening, published }
}
