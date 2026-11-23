/**
 * A call to LifeOS with an end. Convex's own query and mutation never time
 * out, and one whose client is closed under it never settles: a dialog that
 * locks while its call is out would stay locked on its spinner. After `ms`
 * the wait ends with `words`; an answer that comes later is dropped.
 */
export const LIFEOS_WAIT = 10_000;
export function answered<T>(call: Promise<T>, words = "LifeOS did not answer", ms = LIFEOS_WAIT): Promise<T> {
  return new Promise((yes, no) => {
    const timer = setTimeout(() => no(new Error(words)), ms);
    call.then(
      (value) => (clearTimeout(timer), yes(value)),
      (err: unknown) => (clearTimeout(timer), no(err)),
    );
  });
}
