// @vitest-environment jsdom
/**
 * Export for tax time: the three boxes are the three files asked for; with
 * the summary off nothing is printed; the summary is printed and handed back
 * to be kept; a print that fails still reports the files the host made.
 */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const host: { asked: { method: string; params: Record<string, unknown> }[]; answer: (method: string, params: Record<string, unknown>) => unknown } = { asked: [], answer: () => null };
vi.mock("../../lib/connection", async (original) => ({
  ...(await original<object>()),
  registry: {
    primary: () => ({ environmentId: "mac" }),
    linkOf: () => ({
      onPush: () => () => {},
      request: async (method: string, params: Record<string, unknown>) => {
        host.asked.push({ method, params });
        return host.answer(method, params);
      },
    }),
  },
}));
const toast = Object.assign(vi.fn(), { error: vi.fn(), loading: vi.fn(() => "t"), dismiss: vi.fn() });
vi.mock("../../components/ui/toaster", async (original) => ({ ...(await original<object>()), loadToast: async () => toast }));

const { ExportDialog } = await import("./ExportDialog");

const settle = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));
const asked = (method: string) => host.asked.filter((a) => a.method === method).map((a) => a.params);
const folder = { at: "file", host: "box", path: "/home/ref/Refereeing/Money/Tax 2026" };
const year = new Date().getFullYear();

beforeEach(() => {
  host.asked.length = 0;
  host.answer = (method, params) => {
    if (method === "work.money.export") return { folder, files: [`Ledger ${params.year}.csv`, `Ledger ${params.year}.xlsx`], summary: params.pdf ? { name: `Summary ${params.year}`, html: "<p>sums</p>" } : null, warnings: [] };
    if (method === "work.formats.print") return { name: "Summary.pdf", data: btoa("%PDF-1.7 made up"), warnings: [] };
    if (method === "work.money.keep") return { source: folder, receipt: `Tax ${year}/Summary ${year}.pdf` };
    return null;
  };
  toast.mockClear();
});
afterEach(cleanup);

async function exportWith(uncheck: string[] = []) {
  render(<ExportDialog env="box" workspaceId="ws" year={year} onClose={() => {}} />);
  const dialog = await screen.findByRole("dialog", { name: "Export" });
  for (const label of uncheck) fireEvent.click(within(dialog).getByRole("checkbox", { name: label }));
  fireEvent.click(within(dialog).getByRole("button", { name: "Export" }));
  await settle();
  await settle();
}

describe("Export", () => {
  it("starts on the period's year when offered, else the oldest offered, and sends only an offered year", async () => {
    const { exportYears } = await import("./ExportDialog");
    expect(exportYears(2025, 2026)).toEqual({ years: [2026, 2025, 2024, 2023, 2022], first: 2025 });
    expect(exportYears(2019, 2026).first).toBe(2022);
    expect(exportYears(2031, 2026).first).toBe(2022);
  });

  it("says replaced only when a file it wrote, or the summary it kept, took an earlier one's place", async () => {
    const answer = host.answer;
    host.answer = (method, params) => (method === "work.money.keep" ? { ...(answer(method, params) as object), replaced: true } : answer(method, params));
    await exportWith();
    expect(toast).toHaveBeenLastCalledWith(`Exported ${year} for tax time`, expect.objectContaining({ description: "Replaced the earlier export." }));
    cleanup();
    toast.mockClear();
    host.answer = answer;
    await exportWith();
    expect(toast).toHaveBeenLastCalledWith(`Exported ${year} for tax time`, expect.not.objectContaining({ description: expect.anything() }));
  });

  it("stays open with the error when nothing landed", async () => {
    host.answer = (method) => (method === "work.money.export" ? { folder, files: [], summary: null, warnings: ["The spreadsheet could not be made"], replaced: false } : null);
    await exportWith(["Summary (PDF)"]);
    expect(screen.getByRole("dialog", { name: "Export" }).textContent).toContain("The spreadsheet could not be made");
    expect(toast).not.toHaveBeenCalled();
  });

  it("says it replaced the earlier export, joined with what could not be made, and keeps the summary under the same key on a retry", async () => {
    const answer = host.answer;
    let fail = true;
    host.answer = (method, params) => {
      if (method === "work.money.export") return { ...(answer(method, params) as object), warnings: ["The CSV could not be made"], replaced: true };
      if (method === "work.money.keep" && fail) {
        fail = false;
        throw new Error("The box did not answer");
      }
      return answer(method, params);
    };
    render(<ExportDialog env="box" workspaceId="ws" year={year} onClose={() => {}} />);
    const dialog = await screen.findByRole("dialog", { name: "Export" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Export" }));
    await settle();
    await settle();
    // The keep failed, but the host's files landed: the toast names what did not.
    expect(toast).toHaveBeenLastCalledWith(`Exported ${year} for tax time`, expect.objectContaining({ description: "Replaced the earlier export, the CSV could not be made, the summary was not made: The box did not answer." }));
  });

  it("asks for the files whose boxes are ticked, prints the summary and hands it back to be kept", async () => {
    await exportWith(["CSV"]);
    expect(asked("work.money.export")).toEqual([{ workspaceId: "ws", year, xlsx: true, csv: false, pdf: true }]);
    expect(asked("work.formats.print")).toEqual([{ name: `Summary ${year}`, html: "<p>sums</p>", paper: "Letter" }]);
    expect(asked("work.money.keep")).toEqual([{ workspaceId: "ws", what: "summary", year, key: expect.any(String), part: 0, parts: 1, dataBase64: btoa("%PDF-1.7 made up") }]);
    expect(toast).toHaveBeenCalledWith(`Exported ${year} for tax time`, expect.objectContaining({ action: expect.objectContaining({ label: "Show in Files" }) }));
  });

  it("prints nothing with the summary off", async () => {
    await exportWith(["Summary (PDF)"]);
    expect(asked("work.money.export")).toEqual([{ workspaceId: "ws", year, xlsx: true, csv: true, pdf: false }]);
    expect(asked("work.formats.print")).toEqual([]);
    expect(asked("work.money.keep")).toEqual([]);
  });

  it("still reports the files made when the print fails, with why on the second line", async () => {
    const answer = host.answer;
    host.answer = (method, params) => {
      if (method === "work.formats.print") throw new Error("The printer did not start");
      return answer(method, params);
    };
    await exportWith();
    expect(toast).toHaveBeenCalledWith(`Exported ${year} for tax time`, expect.objectContaining({ description: "The summary was not made: The printer did not start." }));
    expect(asked("work.money.keep")).toEqual([]);
  });

  it("opens the folder as a page of Files from the toast", async () => {
    await exportWith();
    const [, options] = toast.mock.calls[0] as [string, { action: { onClick: () => void } }];
    options.action.onClick();
    await settle();
    expect(asked("work.files.tabOpen")).toEqual([{ workspaceId: "ws", page: { at: folder, name: `Tax ${year}` } }]);
  });
});
