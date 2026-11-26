/**
 * A big answer on a remote window's socket, in parts (wire.ts `AnswerParts`, lib/connection/transport.ts).
 *
 * One socket carries a window's every frame in order, so a 4 MiB file piece written whole sits in front of the
 * shown thread's next row until it has crossed the link: 3.4 s at 10 Mbit/s. The tunnel and the edge take what the
 * host writes and hold it, so the host's own unsent bytes undercount what is in front. So a content
 * answer (a file read, a transcript page, a row's body) larger than a part goes as text parts of PART_CHARS, each
 * a message of its own, with no more than UNACKED_CHARS of them out that the window has not said it holds; every
 * other frame (a push, a small answer, a list) goes at once, between parts. A part is not JSON:
 *
 *   `#part <id> <index> <count>\n<the answer's JSON text, chars [index × PART_CHARS, …)>`
 *
 * and the window answers each with `#ack <chars of part bodies received on this socket>`. A window asks for parts
 * with `#parts` once its host's hello names `answer.parts`; nothing else (a phone, a peer link) ever sees one.
 */

export const PART_CHARS = 128 * 1024
export const UNACKED_CHARS = 512 * 1024
export const PARTS_HELLO = '#parts'
const PART = '#part '
const ACK = '#ack '

export function partText(id: string, index: number, count: number, body: string): string {
  return `${PART}${id} ${index} ${count}\n${body}`
}

/** A part's header and body, or null for any other message. */
export function readPart(text: string): { id: string; index: number; count: number; body: string } | null {
  if (!text.startsWith(PART)) return null
  const nl = text.indexOf('\n')
  if (nl < 0) return null
  const [id, index, count] = text.slice(PART.length, nl).split(' ')
  const i = Number(index)
  const n = Number(count)
  if (!id || !Number.isInteger(i) || !Number.isInteger(n) || i < 0 || i >= n) return null
  return { id, index: i, count: n, body: text.slice(nl + 1) }
}

export const ackText = (chars: number): string => `${ACK}${chars}`

/** The chars an ack says the window holds, or null for any other message. */
export function readAck(text: string): number | null {
  if (!text.startsWith(ACK)) return null
  const n = Number(text.slice(ACK.length))
  return Number.isFinite(n) && n >= 0 ? n : null
}
