import { getFunctionName } from "convex/server";
import { X } from "../../chrome/icons";
import { Page } from "../../components/page";
import { Button } from "../../components/ui/button";
import { setLifeosSession, setLifeosStatus } from "../shell/lifeos";
import { StartPlaceForm, StartPlacesSection } from "./StartPlaces";
import type { StartPlaces, StartSettings } from "./places";

/**
 * Start places over fixed data, for `bun run ui:preview
 * src/renderer/src/work/clashes/StartPlaces.preview.tsx#StartPlacesPreview`:
 * `section` (the rows in every state: found, none, looking, failed) and
 * `dialog` (a job's dialog in the dialog's own box, since a dialog draws in a
 * portal a static page cannot hold). Rendered by nothing in the app.
 */

const PLACES: StartPlaces = {
  home: { address: "9 Office Rd", label: "9 Office Road, Cedar Falls, IN", state: "found" },
  jobs: [
    { sector: "cosmic", lookups: true, state: "none" },
    { sector: "hypixel", lookups: true, address: "5 Pine Ave", state: "looking" },
    { sector: "purdue", lookups: false, address: "Cedar Hall, 4 Elm St, Cedar Falls, IN", label: "Cedar Hall, 4 Elm Street, Cedar Falls, IN", state: "found" },
    { sector: "ref", lookups: true, address: "2 Gym Ln, Cedar Fals", state: "failed" },
    { sector: "unify", lookups: true, state: "none" },
    { sector: "life", lookups: true, state: "none" },
  ],
};
const SETTINGS: StartSettings = { homeAddress: "9 Office Rd", starts: { hypixel: "5 Pine Ave", purdue: "Cedar Hall, 4 Elm St, Cedar Falls, IN", ref: "2 Gym Ln, Cedar Fals" } };
const SECTORS = ["cosmic", "hypixel", "purdue", "ref", "unify", "life"].map((key, order) => ({ key, label: key.charAt(0).toUpperCase() + key.slice(1), order }));
const ANSWERS: Record<string, unknown> = { "settings:startPlaces": PLACES, "settings:get": SETTINGS, "sectors:list": SECTORS };

// A session with a client that answers each query at once from the table above.
const ENV = "preview-start-places";
setLifeosStatus(ENV, { lifeos: { state: "connected" }, keys: [] } as never);
setLifeosSession({
  environmentId: ENV,
  sector: null,
  state: "connected",
  client: { watchQuery: (ref: never) => ({ localQueryResult: () => ANSWERS[getFunctionName(ref)], onUpdate: () => () => {} }) } as never,
});

const none = (): void => {};

export function StartPlacesPreview({ state = "section" }: { state?: "section" | "dialog" | "blocked" }) {
  if (state === "dialog" || state === "blocked") {
    const purdue = PLACES.jobs[2]!;
    return (
      <div className="p-6">
        <div className="flex w-full max-w-md flex-col overflow-hidden rounded-2xl bg-popover text-sm leading-[22px] text-popover-foreground shadow-overlay ring-1 ring-border">
          <header className="flex items-start gap-2 px-5 pt-5">
            <h2 className="min-w-0 flex-1 text-base leading-6 font-semibold tracking-[-0.01em] text-foreground">Purdue</h2>
            <Button variant="ghost" size="icon-sm" aria-label="Close" className="-me-1 -mt-0.5 text-muted-foreground">
              <X />
            </Button>
          </header>
          <StartPlaceForm target="purdue" place={purdue} lookups={purdue.lookups} settings={SETTINGS} blocked={state === "blocked" ? "LifeOS did not answer" : null} send={async () => null} onClose={none} pending={null} setPending={none} />
        </div>
      </div>
    );
  }
  return (
    <div className="w-[864px] bg-background">
      <Page title="Work">
        <StartPlacesSection environmentId={ENV} />
      </Page>
    </div>
  );
}
