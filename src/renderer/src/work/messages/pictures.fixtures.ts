/**
 * Made-up pictures for the Messages preview and tests: two flat vector
 * frames standing in for the screenshots people share in chat. They are
 * `data:` addresses, so the page loads nothing from the web, and they carry
 * their own colours, as any picture does (they are content, not the app's).
 */

const svg = (width: number, height: number, body: string): string =>
  `data:image/svg+xml;utf8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${body}</svg>`)}`;

/** A level at dusk, 1600 by 900: layered hills under a low sun. */
export const LEVEL = svg(
  1600,
  900,
  `<defs><linearGradient id="s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1f2a5a"/><stop offset="0.6" stop-color="#c8607a"/><stop offset="1" stop-color="#f4b07a"/></linearGradient></defs>
  <rect width="1600" height="900" fill="url(#s)"/>
  <circle cx="1120" cy="560" r="120" fill="#ffd9a0"/>
  <path d="M0 620 C 300 520 520 700 820 600 S 1340 520 1600 610 V 900 H 0 Z" fill="#6b3a6e"/>
  <path d="M0 720 C 260 660 600 800 900 720 S 1400 660 1600 740 V 900 H 0 Z" fill="#3d2450"/>
  <path d="M0 820 C 400 780 800 860 1200 810 S 1500 800 1600 830 V 900 H 0 Z" fill="#1d1430"/>
  <rect x="700" y="736" width="28" height="44" rx="6" fill="#1d1430"/>`,
);

/** A menu screen, 900 by 1200: an inventory grid on a deep panel. */
export const INVENTORY = svg(
  900,
  1200,
  `<rect width="900" height="1200" fill="#14202b"/>
  <rect x="60" y="80" width="780" height="72" rx="14" fill="#1e3242"/>
  ${Array.from({ length: 16 }, (_, i) => `<rect x="${60 + (i % 4) * 200}" y="${200 + Math.floor(i / 4) * 200}" width="180" height="180" rx="18" fill="${["#2a4a5e", "#3b6a52", "#6a4a8a", "#8a6a2e"][(i * 7) % 4]}"/>`).join("")}
  <rect x="60" y="1040" width="380" height="80" rx="16" fill="#3fa37a"/>`,
);
