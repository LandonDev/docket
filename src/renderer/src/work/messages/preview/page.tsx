import { ConvexReactClient } from "convex/react";
import { createRoot } from "react-dom/client";
import { Toaster } from "../../../components/ui/toaster";
import { changeScheme } from "../../../lib/placeScheme";
import type { LifeosSession } from "../../shell/lifeos";
import { MessagesDataProvider } from "../data";
import { liveData } from "../live";
import { MessagesPreview } from "../MessagesView.preview";
import { MessagesScreen } from "../MessagesView";

/**
 * The Messages view in a real Chromium, with no app and no host:
 * `bun scripts/messages-preview.ts` builds this page, serves it under the
 * app's own page policy and drives it for the speed proof, the shots that
 * need a pointer, and the one live read. It is not part of the app: nothing
 * imports it.
 *
 * The address sets the scene: `?scene=open-direct` (MessagesView.preview.tsx's
 * scenes, on made-up conversations), `?theme=light`. `?live=<sector>` reads
 * LifeOS itself instead, as a sign-in narrowed to that sector: the address
 * and the token come in the fragment (`#<convex url>|<jwt>`), which no
 * server sees.
 */

const params = new URLSearchParams(location.search);
changeScheme(params.get("theme") === "light" ? "light" : "dark", true);

const live = params.get("live");

function Live({ sector }: { sector: string }) {
  const [url, jwt] = decodeURIComponent(location.hash.slice(1)).split("|");
  const client = new ConvexReactClient(url!);
  client.setAuth(async () => jwt!);
  const session: LifeosSession = { environmentId: "preview", sector, client, state: "connected" };
  return (
    <MessagesDataProvider value={liveData(session, sector)}>
      <MessagesScreen workspaceId={`live-${sector}`} job={sector} />
    </MessagesDataProvider>
  );
}

// The fixtures are made inside the first render: the speed run times from here.
(window as unknown as { __builtAt: number }).__builtAt = performance.now();

createRoot(document.getElementById("root")!).render(
  <>
    <div className="h-screen bg-background text-foreground">
      {live ? <Live sector={live} /> : <MessagesPreview scene={params.get("scene") ?? "list"} width={window.innerWidth} height={window.innerHeight} />}
    </div>
    <Toaster />
  </>,
);
