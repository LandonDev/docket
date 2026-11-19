/** Where the comment bar or field starts: at the selection, but never past the page's right edge, nor its left. */
export function commentLeft(x: number, width: number, frameWidth: number): number {
  return Math.max(0, Math.min(x, frameWidth - width));
}
