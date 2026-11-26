import type { ReactNode } from "react";
import { Avatar as AvatarPrimitive } from "@base-ui/react/avatar";
import { cn } from "@renderer/lib/cn";

const AVATAR_SIZES = { 16: "size-4", 18: "size-[18px]", 20: "size-5", 24: "size-6", 28: "size-7", 40: "size-10" } as const;

type AvatarSize = keyof typeof AVATAR_SIZES;

/** A name's initials: the first letter of its first and last words; one word gives one letter. */
function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  const first = [...words[0]][0] ?? "";
  const last = words.length > 1 ? ([...words[words.length - 1]][0] ?? "") : "";
  return (first + last).toUpperCase();
}

/**
 * A face (Kobra's Avatar on Base UI's): the person's picture in a circle, on
 * the image's 1px outline, else their initials on `muted` at 11px medium (one
 * letter under 24px, where two would not read), else what the caller passes
 * (a glyph for a list or a shared mailbox). The picture shows only once it
 * has loaded, so one that fails never flashes a broken image: the initials
 * stand until then. It is decoration beside a name the row already says
 * (`aria-hidden`). No gradient, badge or ring.
 */
function Avatar({
  name,
  src,
  size = 20,
  className,
  children,
}: {
  name: string;
  src?: string | null;
  size?: AvatarSize;
  className?: string;
  /** In place of the initials. */
  children?: ReactNode;
}) {
  const letters = initialsOf(name);
  return (
    <AvatarPrimitive.Root
      aria-hidden
      data-slot="avatar"
      data-size={size}
      className={cn(
        "inline-grid shrink-0 place-items-center overflow-hidden rounded-full bg-muted text-[11px] leading-none font-medium text-muted-foreground outline-1 -outline-offset-1 outline-image-outline select-none",
        AVATAR_SIZES[size],
        className,
      )}
    >
      {src ? <AvatarPrimitive.Image data-slot="avatar-image" src={src} alt="" referrerPolicy="no-referrer" draggable={false} className="size-full object-cover" /> : null}
      <AvatarPrimitive.Fallback data-slot="avatar-fallback">{children ?? (size < 24 ? [...letters][0] : letters)}</AvatarPrimitive.Fallback>
    </AvatarPrimitive.Root>
  );
}

export { Avatar, initialsOf, type AvatarSize };
