import { useEffect, useState, useSyncExternalStore } from "react";
import type { MailFaceProps } from "work-kit/mail";
import { loadBytes } from "work-kit/mail/lib/bytes";
import { Users } from "../../chrome/icons";
import { cn } from "../../lib/cn";
import { News } from "../icons";

/**
 * The one face of a person in Work (docs/DESIGN.md "The Mail view": a face is
 * one avatar everywhere). Mail's kit hands it to the shared mail screens, and
 * People draws it at its own sizes; it lives apart from the kit so a screen
 * that draws faces does not load the mail client to do it.
 */

const initials = (name: string | undefined): string =>
  (name ?? "")
    .replace(/<[^>]*>|["']/g, "")
    .split(/[\s@._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]!.toUpperCase())
    .join("");

/** Mail's four sizes, and `page`: the 40px face that heads a person's page. */
export type FaceSize = NonNullable<MailFaceProps["size"]> | "page";

// Initials are the 11px label step (docs/DESIGN.md "Type scale"), medium, at every size that holds two letters or one; the page's are 13px.
const FACE: Record<FaceSize, string> = {
  line: "size-4 text-[11px] font-medium",
  chip: "size-[18px] text-[11px] font-medium",
  row: "size-6 text-[11px] font-medium",
  head: "size-7 text-[11px] font-medium",
  page: "size-10 text-[13px] font-medium",
};

/**
 * Pictures of faces this window has read, by their address in LifeOS's store: a blob the page may
 * draw (its policy lets no picture load from the web, so the bytes are fetched from LifeOS and
 * handed over), or null for one that did not load. Kept for the session, so a face seen once
 * never shows its initials again; a `data:` picture needs no reading.
 */
const facePictures = new Map<string, string | null>();
const faceReads = new Set<string>();
const faceWaits = new Set<() => void>();
const drawable = (url: string) => url.startsWith("data:") || url.startsWith("blob:");

function readFace(url: string): void {
  if (drawable(url) || facePictures.has(url) || faceReads.has(url)) return;
  faceReads.add(url);
  void loadBytes(url)
    .then(
      (blob) => facePictures.set(url, URL.createObjectURL(blob)),
      () => facePictures.set(url, null),
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
 * A face in a circle on `muted` (docs/DESIGN.md, avatars): 40px heading a person's page, 28px beside
 * an open message's sender, 24px in a list row, 18px in a recipient chip and a fold row. It is the
 * person's picture where LifeOS holds one; else a glyph for a mailing list or a shared mailbox; else
 * initials (the two small sizes hold one letter, which reads at 11px; two would not). A picture that
 * fails to load gives way to what would have stood there, quietly.
 */
export function Face({ name, picture, mark, size = "row", className }: Omit<MailFaceProps, "size"> & { size?: FaceSize }) {
  const letters = initials(name);
  const src = useFacePicture(picture);
  const [broken, setBroken] = useState<string | null>(null);
  const small = size === "chip" || size === "line";
  const Mark = mark === "list" ? News : mark === "group" ? Users : null;
  return (
    <span
      aria-hidden
      className={cn(
        "inline-grid shrink-0 place-items-center overflow-hidden rounded-full bg-muted text-muted-foreground outline-1 -outline-offset-1 outline-(--image-outline)",
        FACE[size],
        className,
      )}
    >
      {src && broken !== src ? (
        <img src={src} alt="" draggable={false} className="size-full object-cover" onError={() => setBroken(src)} />
      ) : Mark ? (
        <Mark className={small ? "size-2.5" : size === "page" ? "size-4" : "size-3.5"} />
      ) : small ? (
        letters.slice(0, 1)
      ) : (
        letters
      )}
    </span>
  );
}
