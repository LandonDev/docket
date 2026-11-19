import { useColorScheme } from "../hooks/useColorScheme";
import { brandInk, brandOf, POPOVER_LUMINANCE } from "../lib/addonBrand";
import type { SlashCommand } from "../lib/tcserver/types";
import { Blocks, Plug, SlashSquare, Terminal } from "./icons";

/** A command's mark: the brand for a known product, else its source glyph.
 *  A brand's colour shows only where it is seen on the menu in this theme
 *  (`brandInk`); otherwise the mark takes the foreground. */
export function AddonMark({
  command,
  size = 14,
  colored = true,
  className = "",
}: {
  command: Pick<SlashCommand, "name" | "source">;
  size?: number;
  /** Brand color for menus; monochrome (currentColor) inside chips. */
  colored?: boolean;
  className?: string;
}) {
  const scheme = useColorScheme();
  const brand = brandOf(command.name);
  if (brand && "img" in brand) {
    const img = (
      <img
        src={brand.img}
        alt=""
        draggable={false}
        width={size}
        height={size}
        className={`shrink-0 object-contain ${brand.lightOnClear ? "" : className}`}
      />
    );
    // A picture keeps its own colours: a light mark gets the black it was drawn for, in both themes.
    return brand.lightOnClear ? <span data-slot="addon-mark-tile" className={`inline-flex shrink-0 overflow-hidden rounded-sm bg-matte ${className}`}>{img}</span> : img;
  }
  if (brand) {
    const ink = colored ? brandInk(brand.hex, POPOVER_LUMINANCE[scheme]) : null;
    return (
      <svg
        viewBox="0 0 24 24"
        width={size}
        height={size}
        className={`shrink-0 ${colored && !ink ? "text-foreground" : ""} ${className}`}
        aria-hidden
      >
        <path d={brand.path} fill={ink ?? "currentColor"} />
      </svg>
    );
  }
  const cls = `shrink-0 text-muted-foreground ${className}`;
  const px = { width: size, height: size };
  switch (command.source) {
    case "plugin":
      return <Blocks style={px} className={cls} />;
    case "mcp":
      return <Plug style={px} className={cls} />;
    case "prompt":
      return <Terminal style={px} className={cls} />;
    default:
      return <SlashSquare style={px} className={cls} />;
  }
}
