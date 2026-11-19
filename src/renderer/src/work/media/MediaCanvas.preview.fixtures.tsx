// Fixtures for `bun run ui:preview src/renderer/src/work/media/MediaCanvas.preview.tsx#MediaPreview --width 864`.
/** The stand-in picture: a poster drawn as the prototype's, standing in for a file a static page cannot decode. A picture keeps its own colours (docs/DESIGN.md "Canvas tints"), so it is fixture data, not a token. */
export const POSTER = `data:image/svg+xml,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1080 1350"><rect width="1080" height="1350" fill="#2a2724"/><text x="86" y="170" fill="#d9b76a" font-family="Inter,sans-serif" font-size="34" font-weight="600" letter-spacing="5">PURDUE ESPORTS</text><text x="80" y="420" fill="#d9b76a" font-family="Inter,sans-serif" font-size="220" font-weight="800">SPRING</text><text x="80" y="620" fill="#d9b76a" font-family="Inter,sans-serif" font-size="220" font-weight="800">LAN</text><text x="86" y="1110" fill="#f3efe6" font-family="Inter,sans-serif" font-size="64" font-weight="700">Saturday, April 11</text><text x="86" y="1180" fill="#f3efe6" font-family="Inter,sans-serif" font-size="48">Memorial Union ballroom</text></svg>`,
)}`;

export default [
  { name: "Reviewing: the player over its comments", props: { moment: "reviewing" } },
  { name: "The agent's notes, waiting on a shared cut", props: { moment: "notes" } },
  { name: "48 minutes, with the chapters the agent added", props: { moment: "long" } },
  { name: "An image", props: { moment: "image" } },
  { name: "Loading", props: { moment: "loading" } },
  { name: "A proxy being made", props: { moment: "preparing" } },
];
