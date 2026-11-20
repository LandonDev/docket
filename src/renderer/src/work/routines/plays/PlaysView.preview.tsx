import type { PlayRow } from "@shared/contract-work-routines";
import { registry, type Link } from "../../../lib/connection";
import { View } from "./PlaysView";

/**
 * The Plays view over one fixed host, for `bun run ui:preview
 * src/renderer/src/work/routines/plays/PlaysView.preview.tsx#PlaysPreview --props '{"state":"list"}'`:
 * his plays with a proposal and the starters left (`list`), plays alone
 * (`plays`), and a new workspace with only its starters (`starters`).
 * Rendered by nothing in the app.
 */

const play = (id: string, name: string, takes: PlayRow["takes"], over: Partial<PlayRow> = {}): PlayRow => ({
  id,
  workspaceId: "ws",
  name,
  instructions: "",
  takes,
  proposed: false,
  madeIn: null,
  starter: null,
  createdBy: "owner",
  createdAt: 1,
  updatedAt: 1,
  host: "local",
  ...over,
});

const PLAYS = [
  play("a", "Game assignment", ["mail"], { starter: "ref.assignment" }),
  play("b", "Crew change", ["mail", "event"]),
  play("c", "Weekly pay check", []),
  play("d", "Post-game report", ["event", "text"]),
];
const PROPOSED = [play("e", "Mileage claim", ["date"], { proposed: true, createdBy: "model" })];

type State = "list" | "plays" | "starters";
let state: State = "list";

const link = {
  environmentId: "local",
  profile: "local",
  connected: true,
  onOpen: () => () => {},
  onClose: () => () => {},
  onPush: () => () => {},
  request<T>(method: string): Promise<T> {
    if (method !== "work.routines.plays") return Promise.reject(new Error(`no ${method}`));
    const plays = state === "starters" ? [] : state === "plays" ? [...PLAYS, play("m", "Month’s pay", ["date"], { starter: "ref.month" })] : [...PLAYS, ...PROPOSED];
    return Promise.resolve({ plays } as T);
  },
} as unknown as Link;
Object.assign(registry, { primary: () => link, linkOf: () => link, link: () => link });

export function PlaysPreview({ state: s = "list" }: { state?: State }) {
  state = s;
  return (
    <div className="h-[520px] w-full">
      <View env="local" workspace={{ id: "ws", environmentId: "local", name: "Refereeing", kind: "work", sector: "ref" } as never} sector="ref" lifeos={{} as never} startThread={() => {}} />
    </div>
  );
}
