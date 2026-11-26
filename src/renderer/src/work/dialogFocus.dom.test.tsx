// @vitest-environment jsdom
/**
 * The live walk (S9): Escape in New task and New event left focus on the page, not on the press that opened them. A
 * field's `autoFocus` took the focus before the dialog knew its opener; Modal's own first focus (`openFocusOf`) picks
 * the same field and keeps the opener. So a Work dialog's field never sets `autoFocus` (the guard below), and Escape
 * gives the focus back.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { useState, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("convex/react", async (original) => ({
  ...(await original<object>()),
  useQuery: () => undefined,
  useMutation: () => vi.fn(),
  useConvex: () => ({}),
  ConvexProvider: ({ children }: { children: unknown }) => children,
}));
vi.mock("./jobName", () => ({ jobNameNow: () => "Purdue Esports" }));

const { NewTaskDialog } = await import("./tasks/NewTaskDialog");
const { NewEventDialog } = await import("./agenda/NewEventDialog");

afterEach(cleanup);

function Opener({ label, dialog }: { label: string; dialog: (close: () => void) => ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button>Elsewhere</button>
      <button onClick={() => setOpen(true)}>{label}</button>
      {open ? dialog(() => setOpen(false)) : null}
    </>
  );
}

async function escapeReturns(label: string, field: string) {
  screen.getByRole("button", { name: "Elsewhere" }).focus();
  const opener = screen.getByRole("button", { name: label });
  opener.focus();
  fireEvent.click(opener);
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("textbox", { name: field })));
  fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  await act(async () => void (await new Promise((done) => setTimeout(done, 400))));
  expect(document.activeElement).toBe(opener);
}

describe("a Work dialog gives the focus back on Escape", () => {
  it("New task: its field takes the focus, and Escape gives it back to New task", async () => {
    render(<Opener label="New task" dialog={(close) => <NewTaskDialog sector="purdue" onClose={close} />} />);
    await escapeReturns("New task", "Task");
  });

  it("New event: the same, to New event", async () => {
    render(<Opener label="New event" dialog={(close) => <NewEventDialog sector="purdue" startsAt={null} onClose={close} />} />);
    await escapeReturns("New event", "Event");
  });
});

/** Fields that focus themselves inside a dialog already open (after its bones, or a step a press brings), when the opener is already kept. */
const KEPT: Record<string, string> = {
  "money/EntryDialog.tsx": "the category field swapped in by its own press, with the dialog open",
  "money/InvoiceDialog.tsx": "its form comes after the bones, once the dialog holds its opener",
  "guests/ShareSheet.tsx": "its form comes after the bones, once the dialog holds its opener",
  "templates/FieldsForm.tsx": "a template's fields, the dialog's second step",
  "msforms/NotAnswered.tsx": "one of two fields by the sector, at open: Modal's initialFocus would take it",
  "routines/plays/RunDialog.tsx": "the first of the play's fields, swapped by the step",
  "clashes/ClashDialog.tsx": "the date of the second step, its field swapped in by a press",
  "outbox/HeldDetail.tsx": "Send later's date, inside its popover",
  "frameio/FrameioRow.tsx": "the steps of Connect, swapped in by its presses",
  "pdf/Fields.tsx": "a field's own popover, opened from the field",
  "meetings/Speaker.tsx": "a speaker's name popover, opened from the name",
};

describe("no Work dialog's field sets autoFocus", () => {
  it("leaves a dialog's first focus to Modal, which keeps the opener", () => {
    const root = __dirname;
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (path.endsWith(".tsx") && !/\.(test|preview)\.tsx$/.test(path)) files.push(path);
      }
    };
    walk(root);
    const found = files
      .filter((path) => {
        const text = readFileSync(path, "utf8");
        return /chrome\/Modal"|components\/ui\/(dialog|popover)"/.test(text) && /\bautoFocus\b/.test(text);
      })
      .map((path) => relative(root, path))
      // SETTINGS' rows and dialogs under work/ are theirs (SEAMS.md).
      .filter((path) => !/^(office\/TeamsFilesRow|mail\/MailSettingsSection|clashes\/StartPlaces|rules\/RuleDialog)\.tsx$/.test(path))
      .filter((path) => !(path in KEPT));
    expect(found).toEqual([]);
  });
});
