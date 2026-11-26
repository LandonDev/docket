// bun run ui:preview src/renderer/src/Splash.preview.tsx#Splash
// Splash draws the HTML in index.html. Launch timing and the handoff to React need the desktop app.
import { readFileSync } from "node:fs";
import { join } from "node:path";

const renderer = join(import.meta.dirname, "..");
const source = readFileSync(join(renderer, "index.html"), "utf8");
const mark = readFileSync(join(renderer, "public/mark.png")).toString("base64");
const css = source.split("<style>")[1]!.split("</style>")[0]!.replaceAll("./mark.png", "data:image/png;base64," + mark);
const splash = source.split("<body>")[1]!.split('<div id="root">')[0]!;

export function Splash() {
  const frame = (light: boolean) => (
    <iframe
      title="Docket launch"
      className={light ? "hidden h-[360px] w-full [.theme-light_&]:block" : "block h-[360px] w-full [.theme-light_&]:hidden"}
      srcDoc={`<!doctype html><html class="${light ? "theme-light" : ""}"><head><style>${css}</style></head><body>${splash}</body></html>`}
    />
  );
  return <>{frame(false)}{frame(true)}</>;
}
