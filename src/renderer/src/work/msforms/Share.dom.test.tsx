// @vitest-environment jsdom
/**
 * Sharing a Microsoft form's link: the QR code is drawn from the link alone, and a sent `msform` chip opens the form in
 * a Files tab of the thread's workspace, by its own source.
 */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { chipRefWords } from "@shared/work/canvas";

const drawn = vi.hoisted(() => ({ texts: [] as string[], opened: [] as unknown[] }));
vi.mock("qrcode", () => ({ default: { toDataURL: async (text: string) => (drawn.texts.push(text), "data:image/png;base64,AAAA") } }));
vi.mock("../files/openFrom", () => ({ openInFiles: async (ws: unknown, what: unknown) => void drawn.opened.push({ ws, what }) }));
const { QrDialog } = await import("./Share");
const { openerOf } = await import("../canvas/SentChips");

const FORM = "Ob0wQVN8nEGx5YdY1tY_IQaWFXVrVqJAiq2zrvrFVrNURDVET1gyWlpLNkJXOUsyWEJXNFlKMzMxVC4u";
const LINK = `https://forms.cloud.microsoft/Pages/ResponsePage.aspx?id=${FORM}`;

afterEach(cleanup);

describe("sharing a Microsoft form", () => {
  it("draws the QR code from the response link alone", async () => {
    render(<QrDialog link={LINK} title="Spring sign-up" onClose={() => undefined} />);
    await waitFor(() => expect(screen.getByRole("img").getAttribute("alt")).toBe(`QR code for ${LINK}`));
    expect(drawn.texts).toEqual([LINK]);
  });

  it("opens a sent msform chip in Files by its source", async () => {
    const source = { at: "msform" as const, host: "env", workspaceId: "w1", formId: FORM, tenant: "purdue0" };
    const open = openerOf({ noun: "Microsoft form", label: "Spring sign-up", ref: chipRefWords({ kind: "msform", ref: source }) } as never, { environmentId: "env", sessionId: "t1", workspaceId: "w1" });
    expect(open).not.toBeNull();
    await open!();
    expect(drawn.opened).toEqual([{ ws: { id: "w1", environmentId: "env" }, what: { ref: source, name: "Spring sign-up" } }]);
  });
});
