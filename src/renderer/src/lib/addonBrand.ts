// Named imports only: a wildcard would pull every brand into the bundle.
import {
  siClerk,
  siCloudflare,
  siConvex,
  siFigma,
  siGithub,
  siGoogledrive,
  siLinear,
  siNotion,
  siPostgresql,
  siSentry,
  siStripe,
  siSupabase,
  siTrello,
  siVercel,
  siWebflow,
} from "simple-icons";
import cosmicAdminMark from "../assets/mcp/cosmic-admin.png";
import lifeosMark from "../assets/mcp/lifeos.png";

/** Brand marks for addon names: a simple-icons vector, or a raster mark for
 *  a brand simple-icons doesn't carry. A raster mark drawn light on clear
 *  (`lightOnClear`) cannot be recoloured, so it sits on a `matte` tile. */
export type BrandIcon = { path: string; hex: string } | { img: string; lightOnClear?: boolean };

const BRANDS: Record<string, BrandIcon | undefined> = {
  linear: siLinear,
  github: siGithub,
  vercel: siVercel,
  stripe: siStripe,
  sentry: siSentry,
  trello: siTrello,
  clerk: siClerk,
  convex: siConvex,
  notion: siNotion,
  figma: siFigma,
  "google-drive": siGoogledrive,
  googledrive: siGoogledrive,
  webflow: siWebflow,
  cloudflare: siCloudflare,
  supabase: siSupabase,
  postgres: siPostgresql,
  "cosmic-admin": { img: cosmicAdminMark, lightOnClear: true },
  lifeos: { img: lifeosMark },
};

export function brandOf(name: string): BrandIcon | undefined {
  return BRANDS[name.toLowerCase()];
}

/** The luminance of the floating layer a coloured mark is drawn on (a menu
 *  row), per theme; addonBrand.test.ts holds these equal to index.css's
 *  `popover`. */
export const POPOVER_LUMINANCE = { dark: 0.0138, light: 1 } as const;

const channel = (c: number): number => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

/** A brand's colour where it is seen on its surface (3:1, the bar for a
 *  mark), else null: the mark then draws in the row's own ink. Black marks
 *  (Notion, Vercel) fail on dark, pale ones (Supabase, Cloudflare) on white. */
export function brandInk(hex: string, surfaceLuminance: number): string | null {
  const [r, g, b] = [0, 2, 4].map((i) => channel(parseInt(hex.slice(i, i + 2), 16) / 255));
  const own = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const [hi, lo] = own > surfaceLuminance ? [own, surfaceLuminance] : [surfaceLuminance, own];
  return (hi + 0.05) / (lo + 0.05) >= 3 ? `#${hex}` : null;
}
