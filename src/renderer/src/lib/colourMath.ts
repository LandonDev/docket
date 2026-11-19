/**
 * Colour arithmetic over index.css's token layer, for the tests that hold
 * the tokens to their contrast and hue rules (tokenContrast, typeTint).
 * Parses hex and the oklch, hsl and rgb functions, each with an optional alpha, and
 * `color-mix(in srgb, A n%, transparent)`; follows `var(--name)` through a theme.
 */

export type Theme = Map<string, string>;

/** The custom properties of every top-level block whose selector is exactly `selector`, in order. */
export function declarations(css: string, selector: string): Theme {
  const source = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const out: Theme = new Map();
  const re = /([^{}]+)\{([^{}]*)\}/g;
  for (let m = re.exec(source); m; m = re.exec(source)) {
    // What precedes the block may be at-rules ending in ";": the selector is what follows the last.
    if (m[1].split(";").pop()!.trim() !== selector) continue;
    for (const decl of m[2].split(";")) {
      const at = decl.indexOf(":");
      if (at < 0) continue;
      const name = decl.slice(0, at).trim();
      if (name.startsWith("--")) out.set(name, decl.slice(at + 1).trim());
    }
  }
  return out;
}

/** The dark theme (`:root`) and the light one (`:root` overlaid by `html.theme-light`). */
export function themes(css: string): { dark: Theme; light: Theme } {
  const dark = declarations(css, ":root");
  return { dark, light: new Map([...dark, ...declarations(css, "html.theme-light")]) };
}

/** `value` with every `var(--name)` in it replaced by that name's value in the theme, all the way down. */
export function resolve(theme: Theme, value: string): string {
  return value.trim().replace(/var\((--[\w-]+)\)/g, (_, name: string) => resolve(theme, theme.get(name) ?? ""));
}

const linear = (c: number): number => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const gamma = (c: number): number => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);
const clamp = (c: number): number => Math.min(1, Math.max(0, c));

/** sRGB channels (gamma-encoded, 0 to 1) and alpha. */
export type Channels = [number, number, number, number];
/** A colour as CSS writes it, or one already read. */
export type Colour = string | Channels;

const number = (part: string, whole = 1): number => (part.endsWith("%") ? parseFloat(part) / 100 : parseFloat(part) / whole);

function oklchToRgb(L: number, C: number, H: number): number[] {
  const a = C * Math.cos((H * Math.PI) / 180);
  const b = C * Math.sin((H * Math.PI) / 180);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ].map((c) => gamma(clamp(c)));
}

function hslToRgb(h: number, s: number, l: number): number[] {
  const a = s * Math.min(l, 1 - l);
  return [0, 8, 4].map((n) => {
    const k = (n + h / 30) % 12;
    return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  });
}

/** Any colour the token layer writes, as sRGB and alpha. Throws on what it cannot read, so no test passes on a guess. */
export function channels(value: Colour): Channels {
  if (typeof value !== "string") return value;
  const v = value.trim().toLowerCase();
  if (v === "transparent") return [0, 0, 0, 0];
  if (v === "white") return [1, 1, 1, 1];
  if (v === "black") return [0, 0, 0, 1];
  const hex = /^#([0-9a-f]{3,8})$/.exec(v);
  if (hex && [3, 4, 6, 8].includes(hex[1].length)) {
    const digits = hex[1].length < 6 ? [...hex[1]].map((d) => d + d).join("") : hex[1];
    const [r, g, b, a = 1] = (digits.match(/../g) ?? []).map((pair) => parseInt(pair, 16) / 255);
    return [r, g, b, a];
  }
  const fn = /^(oklch|hsla?|rgba?)\(([^()]*)\)$/.exec(v);
  if (fn) {
    const [x, y, z, alpha] = fn[2].split(/[\s,/]+/).filter(Boolean);
    const a = alpha === undefined ? 1 : number(alpha);
    if (fn[1] === "oklch") return [...oklchToRgb(number(x), parseFloat(y), parseFloat(z)), a] as Channels;
    if (fn[1].startsWith("hsl")) return [...hslToRgb(parseFloat(x), number(y), number(z)), a] as Channels;
    return [number(x, 255), number(y, 255), number(z, 255), a];
  }
  // A colour thinned toward nothing: its own channels at n% of its alpha.
  const mix = /^color-mix\(in srgb,\s*(.+?)\s+([\d.]+)%\s*,\s*transparent\s*\)$/.exec(v);
  if (mix) {
    const [r, g, b, a] = channels(mix[1]);
    return [r, g, b, (a * parseFloat(mix[2])) / 100];
  }
  throw new Error(`unparsed colour ${value}`);
}

/** `top` laid over the grounds under it, nearest first, as an opaque colour. The last ground must be opaque. */
export function over(top: Colour, ...grounds: Colour[]): Channels {
  let [r, g, b, a] = channels(top);
  for (const ground of grounds) {
    if (a >= 1) break;
    const [gr, gg, gb, ga] = channels(ground);
    const out = a + ga * (1 - a);
    [r, g, b] = [r, g, b].map((c, i) => (c * a + [gr, gg, gb][i] * ga * (1 - a)) / (out || 1));
    a = out;
  }
  if (a < 1 - 1e-9) throw new Error(`${String(top)} is not opaque over ${grounds.join(", ") || "nothing"}`);
  return [r, g, b, 1];
}

/** Linear sRGB of an opaque colour. */
function linearRgb(value: Colour): number[] {
  const [r, g, b, a] = channels(value);
  if (a < 1) throw new Error(`${String(value)} has no luminance until it is laid over a ground (over)`);
  return [r, g, b].map(linear);
}

/** OKLab of an opaque colour. */
export function oklab(value: Colour): [number, number, number] {
  const [r, g, b] = linearRgb(value);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

/** Relative luminance of an opaque colour. */
export function luminance(value: Colour): number {
  const [r, g, b] = linearRgb(value);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast of two opaque colours. */
export function contrast(a: Colour, b: Colour): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** OKLCH hue in degrees, 0 to 360. */
export function hue(value: Colour): number {
  const [, a, b] = oklab(value);
  return ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360;
}

/** The shorter way round the hue circle between two colours, in degrees. */
export function hueDistance(x: Colour, y: Colour): number {
  const d = Math.abs(hue(x) - hue(y));
  return Math.min(d, 360 - d);
}
