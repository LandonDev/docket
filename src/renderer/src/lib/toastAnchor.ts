/**
 * The element the toast stack sits above: the focused thread's strip and
 * composer (ChatFooter marks it), or a master board's foot while its chat is
 * folded (BatchFoot). A registry instead of a DOM query, so nothing watches
 * the document while a transcript streams. The newest registration wins: the
 * pane that gained focus registers last. An anchor inside a folded column
 * (`inert`) seats nothing, and the next one down takes the stack; whoever
 * folds a column, or lays a page over the board, says so with
 * `refreshToastAnchor`.
 *
 * A waiting card (a question, an approval) registers as a seat, and so does
 * the composer's open `/` or `@` menu: while the footer it sits above is the
 * anchor and the seat is wholly in view, the stack sits above it instead, so
 * a toast never covers its presses or its rows.
 */
const anchors: HTMLElement[] = [];
const seats: HTMLElement[] = [];
const listeners = new Set<() => void>();
/** Bumped on every change, so a reader's snapshot moves when a seat comes or goes under the same anchor. */
let version = 0;

function emit(): void {
  version++;
  for (const listener of listeners) listener();
}

function registerIn(list: HTMLElement[], el: HTMLElement | null): (() => void) | undefined {
  if (!el) return undefined;
  list.push(el);
  emit();
  return () => {
    const at = list.lastIndexOf(el);
    if (at < 0) return;
    list.splice(at, 1);
    emit();
  };
}

/** A ref callback: registers the element, and its cleanup unregisters it. */
export function registerToastAnchor(el: HTMLElement | null): (() => void) | undefined {
  return registerIn(anchors, el);
}

/** A ref callback for a waiting card: the stack sits above it while it is in view over the anchor's footer. */
export function registerToastSeat(el: HTMLElement | null): (() => void) | undefined {
  return registerIn(seats, el);
}

export function subscribeToastAnchor(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Changes whenever an anchor or a seat comes, goes or is asked again. */
export function toastAnchorVersion(): number {
  return version;
}

export function toastAnchor(): HTMLElement | null {
  for (let i = anchors.length - 1; i >= 0; i--) {
    if (!anchors[i].closest("[inert]")) return anchors[i];
  }
  return null;
}

/** The session whose chat footer holds the stack (ChatFooter's `data-toast-anchor`): the thread on screen. */
export function seatedSession(): string | null {
  return toastAnchor()?.getAttribute("data-toast-anchor") || null;
}

/** The newest waiting card in the anchor's own pane (the column the footer closes), if any. */
export function toastSeatOver(anchor: HTMLElement): HTMLElement | null {
  const pane = anchor.parentElement;
  for (let i = seats.length - 1; i >= 0; i--) {
    if (pane?.contains(seats[i]) && !seats[i].closest("[inert]")) return seats[i];
  }
  return null;
}

/** A column folded or unfolded, a page laid over the board or lifted: the stack asks again which anchor it sits above. */
export function refreshToastAnchor(): void {
  emit();
}
