import type { ComponentProps } from "react";
import { ChevronRight } from "@renderer/chrome/icons";
import { cn } from "@renderer/lib/cn";
import { Button } from "./button";

/**
 * A trail of places (Kobra's Breadcrumb): a `nav` holding an ordered list, so
 * a reader hears "list, 3 items" and where it is. A place he can go to is a
 * ghost `xs` button; the place he is in is plain foreground text with
 * `aria-current`; between them a 12px muted chevron. 13px, the chrome's size.
 * No motion.
 */
function Breadcrumb({ className, ...props }: ComponentProps<"nav">) {
  return <nav aria-label="Breadcrumb" data-slot="breadcrumb" className={cn("min-w-0", className)} {...props} />;
}

function BreadcrumbList({ className, ...props }: ComponentProps<"ol">) {
  return <ol data-slot="breadcrumb-list" className={cn("flex min-h-6 min-w-0 flex-wrap items-center gap-0.5 text-[13px] text-muted-foreground", className)} {...props} />;
}

function BreadcrumbItem({ className, ...props }: ComponentProps<"li">) {
  return <li data-slot="breadcrumb-item" className={cn("flex min-w-0 items-center gap-0.5", className)} {...props} />;
}

/** A place to go to. Its words cut inside it (`max-w-48` by default), never the trail. */
function BreadcrumbLink({ className, children, ...props }: ComponentProps<typeof Button>) {
  return (
    <Button data-slot="breadcrumb-link" variant="ghost" size="xs" className={cn("max-w-48 min-w-0 shrink justify-start text-[13px] font-normal text-muted-foreground hover:text-foreground", className)} {...props}>
      <span className="truncate">{children}</span>
    </Button>
  );
}

/** The place he is in: the trail's last item. */
function BreadcrumbPage({ className, ...props }: ComponentProps<"span">) {
  return <span data-slot="breadcrumb-page" aria-current="location" className={cn("max-w-48 min-w-0 truncate px-2 text-foreground", className)} {...props} />;
}

function BreadcrumbSeparator({ className, ...props }: ComponentProps<"span">) {
  return (
    <span data-slot="breadcrumb-separator" role="presentation" aria-hidden className={cn("flex shrink-0 text-muted-foreground", className)} {...props}>
      <ChevronRight className="size-3" />
    </span>
  );
}

export { Breadcrumb, BreadcrumbItem, BreadcrumbLink, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator };
