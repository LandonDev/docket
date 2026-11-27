// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { GrantsSheet } from "./GrantsSheet";
import type { HostGrant } from "./store";

/** Round 1's carry: the sheet said "No grants" whenever its list was empty, before the read landed too. */

afterEach(cleanup);
const GRANT: HostGrant = {
  id: "g1",
  environmentId: "box",
  workspaceId: "ws",
  kind: "mail.send",
  matcher: null,
  label: "Replies to Dana Lee",
  madeFrom: { at: "lifeos", table: "outbox", id: "ob_1" },
  routineId: null,
  createdAt: 1,
  removedAt: null,
};
const sheet = (read: boolean, grants: HostGrant[] = []) =>
  render(<GrantsSheet open onOpenChange={() => undefined} grants={grants} read={read} nameOf={() => "Purdue"} sectorOf={() => null} />);
const wait = () => document.querySelector("[role=dialog] [data-region][data-bones]");

describe("the Grants sheet", () => {
  it("draws the grants' own rows as bones while they are read, never the empty line", () => {
    sheet(false);
    expect(wait()).toBeTruthy();
    // The bones are a grant group drawn from the sample, inert and hidden from assistive tech.
    const drawing = wait()!.querySelector("[skullet-loading]")!;
    expect(drawing.getAttribute("aria-hidden")).toBe("true");
    expect(drawing.querySelectorAll("section li")).toHaveLength(2);
    expect(screen.queryByText(/No grants/)).toBeNull();
  });
  it("says there are none once they are read", () => {
    sheet(true);
    expect(screen.getByText("No grants. Everything waits for your press.")).toBeTruthy();
    expect(wait()).toBeNull();
  });
  it("lands the grants over the bones when the read answers", async () => {
    const view = sheet(false);
    view.rerender(<GrantsSheet open onOpenChange={() => undefined} grants={[GRANT]} read nameOf={() => "Purdue"} sectorOf={() => null} />);
    expect(screen.getByRole("region", { name: "Purdue" })).toBeTruthy();
    await waitFor(() => expect(document.querySelector("[skullet-loading]")).toBeNull());
  });
});
