# Setting up a computer from the giver

The plan is .temp-code/plan-d9AVYMURpw9s.md. This page says what is built.

## The trust boundary

- **Trusted with his accounts:** the giver (his Mac) and the box. The box
  already holds the static tokens, refreshes Codex and add-on grants and runs
  his threads.
- **Defended against:** a given computer (a PC, a second Mac, or a key
  stolen from one), a leaked setup link, a replayed or reordered message, and
  the phone and relay lanes. None of them can gain an account they were not
  given, plant one anywhere, or keep one past Stop or Remove at their next
  contact, and none can make two computers refresh one grant.
- **Not defended:** a token copied off a given computer's disk while it was
  given, or held by a computer that never makes contact again (the 30-day
  lease bounds the second).

## The giver and the caps (M2)

- `give` (src/shared/capabilities.ts) is credential control over other
  computers: introducing an account (`accounts.push`), handing one off and
  settling it (`accounts.confirm`, `accounts.released`), withdrawing one
  (`accounts.removed`) and a pull with `takeOver`. `admin` never implies it.
- No key row stores `give`. The box keeps one giver record (settings row
  `devices.giver`: key id, device identity, name; src/main/server/devices/giver.ts),
  and a principal acts with `give` while its key is that one and live
  (`Givers.withGive`, applied at the listener's gate).
- **The cut-over.** The first boot of this build stamps `devices.upgradeAt`
  and ends every open pairing offer. The Mac's desktop calls
  `devices.claimGiver` on each box link before it syncs: the box accepts while
  no giver is set, and only from an admin key made before the stamp. Repeats
  from the giver answer ok. A PC never claims. Only `tc-local
  devices.setGiver '{"keyId":"…"}'` on the box moves or clears it (a press in
  /ui would let any admin key take it). An isolated proof names its stand-in
  giver the same way (scripts/e2e-accounts-sync.ts).
- **Upgrade order.** A box with the cut-over refuses pushes from a Mac
  without it; both sides ship in one release.
- `device` is a given computer's key. Its admin-tier calls are the
  `DEVICE_METHODS` allowlist; `DEVICE_REFUSED` is refused whatever else it
  holds; operate and approve work as on any key, so the PC's window runs box
  threads. `capabilityRefusal` is the one check, at the listener and on
  relayed lanes. `peers.ts` opens links for admin or device keys
  (`opensPeerLink`).
- Each install has a device identity (Ed25519 to sign, X25519 to be sealed
  to; src/shared/devices/keys.ts), made on first need and kept in its own
  vault as the bare secret `addon/~device-identity`, never synced
  (devices/identity.ts).

## Accounts on many computers (M2)

- **One admission check** (devices/admission.ts) on every receive path (the
  giver's push, a pull's answer, a rotation push, askOwner, a takeover) and
  on the box's export: the exact service and account id (an email that names
  another row is refused), only a row on file under the peer policy, no
  refresh token unless it is a handoff where one may arrive, and on a given
  computer only what its manifest names, by kind and owner.
- **Handoffs** go between the giver and the box only (`give`). Each has an id;
  its release or confirm must name the id and the grant's refresh
  fingerprint, else `stale`. Each side keeps its half in a settings row
  (`accounts.handoff.`, `accounts.released.`, `accounts.taking.`) so a restart
  settles it. Neither side hands out the grant its CLI is signed in with, and
  a lineage check that fails counts as that grant.
- **Every host decides for itself.** A relayed lane's principal carries
  `via`; its host runs only what RELAY_METHODS carries (devices/hostRules.ts).
  `work.lifeos.setToken` is local-only. On a given computer the LifeOS
  session and every credential method are refused to remote principals
  (`GIVEN_HOST_LOCAL`).
