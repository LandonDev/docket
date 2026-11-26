import { HugeiconsIcon, type HugeiconsIconProps, type IconSvgElement } from "@hugeicons/react";
import { forwardRef, type Ref } from "react";

/** Props shared by every chrome icon. `icon` is filled in by the named wrappers. */
export type IconProps = Omit<HugeiconsIconProps, "icon">;

export type IconComponent = ReturnType<typeof wrap>;

/** Every chrome icon's stroke, docs/DESIGN.md "Iconography": a size fixes a glyph that reads thin, never a heavier stroke. */
export const ICON_STROKE = 1.5;

/** A glyph under a name: the stroke's default applied. A lazy surface's own glyphs (work/icons.tsx) are made with it, so they stay out of this module. */
export function wrap(icon: IconSvgElement, name: string) {
  const Component = forwardRef(function Icon(
    { strokeWidth = ICON_STROKE, ...props }: IconProps,
    ref: Ref<SVGSVGElement>,
  ) {
    return (
      <HugeiconsIcon
        ref={ref}
        icon={icon}
        strokeWidth={strokeWidth}
        {...props}
      />
    );
  });
  Component.displayName = name;
  return Component;
}
