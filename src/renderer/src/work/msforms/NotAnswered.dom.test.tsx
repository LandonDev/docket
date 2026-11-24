// @vitest-environment jsdom
/** Who hasn't answered, while the job's LifeOS session is down (council round 9's walk): the line, his addresses kept, Check still his. */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/tcserver/workspaces", async (original) => ({ ...(await original<object>()), useWorkspaces: () => [{ id: "ws", environmentId: "box", sector: "purdue" }] }));
vi.mock("../../lib/connection", async (original) => ({ ...(await original<object>()), registry: { environment: () => ({ name: "The box" }), linkOf: () => ({ request: async () => ({}), onPush: () => () => {}, onOpen: () => () => {} }) } }));
vi.mock("../shell/lifeos", async (original) => ({
  ...(await original<object>()),
  useLifeosSession: () => ({ environmentId: "box", sector: "purdue", client: null, state: "signed-out" }),
  useLifeosQuery: () => ({ status: "failed", error: "Not signed in to LifeOS on the box" }),
}));

const { NotAnsweredDialog } = await import("./NotAnswered");
afterEach(cleanup);

describe("Who hasn't answered, LifeOS down", () => {
  it("says the session's line with the computer named in the people's place, keeps what he pasted and still checks it", () => {
    render(<NotAnsweredDialog env="box" workspaceId="ws" answered={["dana@purdue.edu"]} onClose={() => {}} />);
    const line = document.querySelector("[data-people-down]")!;
    expect(line.textContent).toContain("Not signed in to LifeOS on the box");
    expect(screen.queryByText(/People did not load/)).toBeNull();
    fireEvent.change(screen.getByLabelText("Or paste addresses"), { target: { value: "dana@purdue.edu, sam@purdue.edu" } });
    fireEvent.click(screen.getByRole("button", { name: "Check" }));
    expect(screen.getByText("1 of 2 haven't answered")).toBeTruthy();
  });
});
