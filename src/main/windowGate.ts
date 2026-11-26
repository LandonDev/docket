/**
 * What may make a window, waiting for what must end before any window does (index.ts boot order): the
 * localStorage move off file:// and the live-Office fence. A Dock click, the Dock menu's New Window and the
 * menu's New Window that come sooner wait for it, then run once, in order.
 */
export interface WindowGate {
  /** The walls are up: queued window work runs, and later work runs at once. */
  open(): void
  /** Run `make` once windows may be made. */
  run(make: () => void): void
}

export function windowGate(): WindowGate {
  let opened = false
  const waiting: (() => void)[] = []
  return {
    open() {
      if (opened) return
      opened = true
      for (const make of waiting.splice(0)) make()
    },
    run(make) {
      if (opened) make()
      else waiting.push(make)
    }
  }
}

/**
 * The boot's own windows, then the gate: the saved slots open first, so a Dock click held at the gate finds them
 * and only brings one forward, and a held New Window takes a fresh slot after the saved list was read; no slot
 * opens twice and no two windows share one.
 */
export function openSavedThenGate<T>(gate: WindowGate, openSaved: () => T): T {
  const up = openSaved()
  gate.open()
  return up
}

/** The app's one gate. */
export const windowsGate = windowGate()
