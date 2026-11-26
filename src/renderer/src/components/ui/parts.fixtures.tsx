// Fixtures for `bun run ui:preview src/renderer/src/components/ui/parts.fixtures.tsx#PartsGallery`:
// the three small parts taken from Kobra beside each other: a face at every
// size (initials; a picture shows only once it has loaded, which a static page
// never does), a trail of places, and a slider with its default track.
// Keys, focus and a loaded picture are DOM-tested (ui.dom.test.tsx).
import type { ReactNode } from "react";
import { Avatar } from "./avatar";
import { Breadcrumb, BreadcrumbItem, BreadcrumbLink, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator } from "./breadcrumb";
import { Slider } from "./slider";

function Case({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-xs font-medium text-muted-foreground">{title}</h3>
      {children}
    </section>
  );
}

export function PartsGallery() {
  return (
    <div className="flex max-w-sm flex-col gap-6">
      <Case title="Avatar: 16, 18, 20, 24, 28, 40">
        <div className="flex items-center gap-3">
          {([16, 18, 20, 24, 28, 40] as const).map((size) => (
            <Avatar key={size} name="Ada Lovelace" size={size} />
          ))}
        </div>
        <div className="flex items-center gap-2 text-[13px]">
          <Avatar name="grace hopper" size={20} />
          <span>grace hopper</span>
          <span className="text-muted-foreground">commented 2h ago</span>
        </div>
      </Case>
      <Case title="Breadcrumb">
        <Breadcrumb aria-label="Folder">
          <BreadcrumbList>
            <BreadcrumbItem>
              <BreadcrumbLink>work</BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbItem>
              <BreadcrumbSeparator />
              <BreadcrumbLink>temp-code</BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbItem>
              <BreadcrumbSeparator />
              <BreadcrumbPage>a-folder-with-a-name-long-enough-to-be-cut-inside-the-trail</BreadcrumbPage>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>
      </Case>
      <Case title="Slider">
        <Slider aria-label="Volume" defaultValue={40} />
        <Slider aria-label="Volume, off" defaultValue={70} disabled />
      </Case>
    </div>
  );
}
