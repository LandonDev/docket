import { useEffect, useSyncExternalStore } from "react";
import type { MailFaceProps } from "work-kit/mail";
import { loadBytes } from "work-kit/mail/lib/bytes";
import { Users } from "../../chrome/icons";
import { Avatar, type AvatarSize } from "../../components/ui/avatar";
import { cn } from "../../lib/cn";
import { News } from "../icons";

/**
 * The one face of a person in Work (docs/DESIGN.md "The Mail view": a face is
 * one avatar everywhere). Mail's kit hands it to the shared mail screens; People,
 * the canvas bar, media notes, History, Share and the projects kit draw it at their
 * own sizes; it lives apart from the kit so a screen that draws faces does not load
 * the mail client to do it.
 */

const initials = (name: string | undefined): string =>
  (name ?? "")
    .replace(/<[^>]*>|["']/g, "")
    .split(/[\s@._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]!.toUpperCase())
    .join("");

/** Mail's four sizes; `bar`, the 20px face in a canvas bar and a note; `page`, the 40px face that heads a person's page. */
export type FaceSize = NonNullable<MailFaceProps["size"]> | "bar" | "page";

/** Each size's pixels on the shared Avatar. */
const PX: Record<FaceSize, AvatarSize> = { line: 16, chip: 18, bar: 20, row: 24, head: 28, page: 40 };

/**
 * Pictures of faces this window has read, by their address in LifeOS's store: a blob the page may
 * draw (its policy lets no picture load from the web, so the bytes are fetched from LifeOS and
 * handed over), or null for one that did not load. Kept for the session, so a face seen once
 * never shows its initials again; a `data:` picture needs no reading.
 */
const facePictures = new Map<string, string | null>();
/** The most face pictures kept; past it the one drawn longest ago goes and its blob is let go (`revokeObjectURL`). */
export const FACES_KEPT = 120;
const faceReads = new Set<string>();
const faceWaits = new Set<() => void>();
const drawable = (url: string) => url.startsWith("data:") || url.startsWith("blob:");

/** A face read: kept as the newest, the oldest past FACES_KEPT dropped and its blob revoked. */
function keepFace(url: string, picture: string | null): void {
  facePictures.delete(url);
  facePictures.set(url, picture);
  while (facePictures.size > FACES_KEPT) {
    const [old, blob] = facePictures.entries().next().value!;
    facePictures.delete(old);
    if (blob) URL.revokeObjectURL(blob);
  }
}

/** A face drawn again moves to the newest end, so the ones on screen are the last to go. */
function touchFace(url: string): void {
  if (!facePictures.has(url)) return;
  const picture = facePictures.get(url)!;
  facePictures.delete(url);
  facePictures.set(url, picture);
}

/** Tests: how many are kept, and a read's landing. */
export const facesKept = (): number => facePictures.size;
export const keepFaceForTests = keepFace;

function readFace(url: string): void {
  if (drawable(url) || faceReads.has(url)) return;
  if (facePictures.has(url)) return touchFace(url);
  faceReads.add(url);
  void loadBytes(url)
    .then(
      (blob) => keepFace(url, URL.createObjectURL(blob)),
      () => keepFace(url, null),
    )
    .finally(() => {
      faceReads.delete(url);
      for (const wake of faceWaits) wake();
    });
}

const waitForFaces = (wake: () => void) => {
  faceWaits.add(wake);
  return () => void faceWaits.delete(wake);
};

/** The picture to draw for a stored one: there at once when it was read before, undefined until it is or when it failed. */
export function useFacePicture(url: string | undefined): string | undefined {
  const held = useSyncExternalStore(waitForFaces, () => (!url ? undefined : drawable(url) ? url : (facePictures.get(url) ?? undefined)));
  useEffect(() => {
    if (url) readFace(url);
  }, [url]);
  return held;
}

/**
 * A face in a circle on `muted` (docs/DESIGN.md, avatars), on the shared Avatar: 40px heading a person's page, 28px
 * beside an open message's sender, 24px in a list row, 20px in a bar, 18px in a recipient chip and a fold row, 16px on
 * a line. It is the person's picture where LifeOS holds one (`picture`, read as bytes) or one the page may draw as it
 * is (`src`: a collaborator's avatar); else a glyph for a mailing list or a shared mailbox; else initials, 11px medium
 * (the label step, docs/DESIGN.md "Type scale"; the page's 13px), one letter in the three sizes under 24px, which reads
 * at 11px where two would not. A picture shows once it has loaded, so one that fails never flashes: what would have
 * stood there stays, quietly.
 */
export function Face({ name, picture, src: given, mark, size = "row", className }: Omit<MailFaceProps, "size"> & { size?: FaceSize; src?: string | undefined }) {
  const letters = initials(name);
  const read = useFacePicture(given ? undefined : picture);
  const small = size === "chip" || size === "line" || size === "bar";
  const Mark = mark === "list" ? News : mark === "group" ? Users : null;
  return (
    <Avatar name={name ?? ""} src={given ?? read} size={PX[size]} className={cn(size === "page" && "text-[13px]", className)}>
      {Mark ? <Mark className={small ? "size-2.5" : size === "page" ? "size-4" : "size-3.5"} /> : small ? letters.slice(0, 1) : letters}
    </Avatar>
  );
}
