// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { defineChunk } from "../../lib/lazyChunk";
import { useKindModule } from "./CanvasPane";
import type { CanvasKindModule } from "./kind";

afterEach(cleanup);

const module = (name: string): CanvasKindModule => ({ Body: () => null, Bar: () => <span>{name}</span> }) as unknown as CanvasKindModule;
function Probe({ chunk }: { chunk: Parameters<typeof useKindModule>[0] }) {
  const got = useKindModule(chunk);
  const Bar = got?.Bar as unknown as (() => React.ReactNode) | undefined;
  return <div data-probe>{Bar ? <Bar /> : "bone"}</div>;
}

describe("a kind's module under its seat", () => {
  it("is null until the kind's chunk lands, then the module, with no remount", async () => {
    let land!: (m: CanvasKindModule) => void;
    const chunk = defineChunk<CanvasKindModule>("test-kind-late", () => new Promise((done) => (land = done)));
    const view = render(<Probe chunk={chunk} />);
    expect(view.container.textContent).toBe("bone");
    await act(async () => land(module("late")));
    expect(view.container.textContent).toBe("late");
  });

  it("takes another kind's module in the same render when that chunk is already loaded, and waits for one that is not", async () => {
    const first = defineChunk<CanvasKindModule>("test-kind-first", async () => module("first"));
    const second = defineChunk<CanvasKindModule>("test-kind-second", async () => module("second"));
    await first.load();
    await second.load();
    let land!: (m: CanvasKindModule) => void;
    const third = defineChunk<CanvasKindModule>("test-kind-third", () => new Promise((done) => (land = done)));
    const view = render(<Probe chunk={first} />);
    expect(view.container.textContent).toBe("first");
    view.rerender(<Probe chunk={second} />);
    expect(view.container.textContent).toBe("second");
    view.rerender(<Probe chunk={third} />);
    expect(view.container.textContent).toBe("bone");
    await act(async () => land(module("third")));
    expect(view.container.textContent).toBe("third");
  });

  // The window's build runs the React Compiler, which this test's does not: it holds a call's answer while the
  // argument is the same, so a chunk's `loaded()` read in the hook's body would stay null after the chunk landed.
  it("never reads the chunk's module in the hook's body, where the compiler would hold the first answer", () => {
    const source = readFileSync(join(process.cwd(), "src/renderer/src/work/canvas/CanvasPane.tsx"), "utf8");
    const hook = source.slice(source.indexOf("export function useKindModule"), source.indexOf("\n}\n", source.indexOf("export function useKindModule")));
    expect(hook).toContain("useState");
    expect(hook).not.toMatch(/^\s*const \w+ = chunk\.loaded\(\);$/m);
  });
});
