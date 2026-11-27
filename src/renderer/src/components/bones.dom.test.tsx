// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BONES } from "../lib/ease";
import { MOTION_PREFERENCE_DEFAULT, saveMotionPreference } from "../lib/motion";
import { Arrive, Bone, Bones, Loaded, Region, useInBones } from "./bones";

/*
 * The loading rules (docs/agents/loading-bones.md), as far as a window with no layout can show
 * them: jsdom measures nothing, so every reveal is instant and what is held here is the order of
 * things, not the picture. The picture is proven in a real window (`bun run ui:preview`).
 */

beforeEach(() => {
  // The clock too: the hold and what counts as bones just left are read from `performance.now()`.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
  // Past the launch, and past the test before: a faked clock starts again at nought, and bones that "left" after now would be followed.
  vi.advanceTimersByTime(100_000 * ++run);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  saveMotionPreference(MOTION_PREFERENCE_DEFAULT);
});

let run = 0;
const region = (container: HTMLElement) => container.querySelector<HTMLElement>("[data-region]")!;
const Row = ({ name }: { name: string }) => <p data-row>{name}</p>;

/** Mounts a region, lands a read in it and lets its content settle, so the next region's wait is its own. */
function settle() {
  const first = render(
    <Region loading={false} bones={<Row name="Sample" />}>
      <Row name="Real" />
    </Region>,
  );
  first.unmount();
  act(() => void vi.advanceTimersByTime(BONES.followsMs + 1));
}

describe("a region", () => {
  beforeEach(settle);

  it("holds its bones back for 150 ms, then shows them", () => {
    const { container } = render(
      <Region loading bones={<Row name="Sample" />} label="Loading notes">
        <Row name="Real" />
      </Region>,
    );
    expect(region(container).dataset.bones).toBe("held");
    expect(screen.getByRole("status").textContent).toBe("");
    act(() => void vi.advanceTimersByTime(BONES.holdMs - 1));
    expect(region(container).dataset.bones).toBe("held");
    act(() => void vi.advanceTimersByTime(1));
    expect(region(container).dataset.bones).toBe("shown");
    // Bones that waited come in by a fade; the wait is said once they show.
    expect(region(container).hasAttribute("data-bones-waited")).toBe(true);
    expect(screen.getByRole("status").textContent).toBe("Loading notes");
  });

  it("holds the content's room from its first commit: the sample is drawn, unseen and inert, and measured only once the bones show", () => {
    const { container } = render(<Region loading bones={<Row name="Sample" />} />);
    const drawing = container.querySelector<HTMLElement>("[skullet-loading]")!;
    expect(drawing.getAttribute("aria-hidden")).toBe("true");
    expect(drawing.hasAttribute("inert")).toBe(true);
    expect(drawing.querySelector("[skullet-ghost] [data-row]")!.textContent).toBe("Sample");
    // Skullet marks what it has measured; before the hold is over nothing has been.
    const measured = () => drawing.querySelector("[skullet-ghost]")!.hasAttribute("skullet-inactive") || drawing.querySelector("[skullet-layer]")!.shadowRoot !== null;
    expect(measured()).toBe(false);
    act(() => void vi.advanceTimersByTime(BONES.holdMs));
    expect(measured()).toBe(true);
  });

  it("shows no bones for a read that answers inside the hold", async () => {
    const view = (loading: boolean) => (
      <Region loading={loading} bones={<Row name="Sample" />}>
        <Row name="Real" />
      </Region>
    );
    const { container, rerender } = render(view(true));
    act(() => void vi.advanceTimersByTime(BONES.holdMs - 50));
    rerender(view(false));
    expect(region(container).dataset.bones).toBeUndefined();
    expect(screen.getByText("Real")).toBeTruthy();
    // The unseen bones go with the next turn of the loop, on no fade and no frame.
    await act(async () => void (await vi.advanceTimersByTimeAsync(0)));
    expect(container.querySelector("[skullet-loading]")).toBeNull();
    expect(region(container).dataset.bones).toBeUndefined();
  });

  it("brings its content in over the bones and lets the bones go", async () => {
    const view = (loading: boolean) => (
      <Region loading={loading} bones={<Row name="Sample" />}>
        <Row name="Real" />
      </Region>
    );
    const { container, rerender } = render(view(true));
    act(() => void vi.advanceTimersByTime(BONES.holdMs));
    rerender(view(false));
    // The content is in the commit its read answered in; the bones are on their way out beside it.
    expect(screen.getByText("Real")).toBeTruthy();
    expect(region(container).dataset.bones).toBe("leaving");
    expect(region(container).getAttribute("aria-busy")).toBeNull();
    await act(async () => void (await vi.advanceTimersByTimeAsync(BONES.leaveCapMs)));
    expect(container.querySelector("[skullet-loading]")).toBeNull();
    expect(region(container).dataset.bones).toBeUndefined();
  });

  it("drops the leaving bones after the cap where no frame ever comes for their fade to end on", async () => {
    // A hidden window: an animation there never finishes.
    const animate = vi.spyOn(Element.prototype, "animate").mockImplementation(() => ({ finished: new Promise(() => {}), cancel() {}, finish() {}, updatePlaybackRate() {} }) as unknown as Animation);
    const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    const view = (loading: boolean) => (
      <Region loading={loading} hold={0} bones={<Row name="Sample" />}>
        <Row name="Real" />
      </Region>
    );
    const { container, rerender } = render(view(true));
    rerender(view(false));
    expect(screen.getByText("Real")).toBeTruthy();
    await act(async () => void (await vi.advanceTimersByTimeAsync(BONES.leaveCapMs + 1)));
    expect(container.querySelector("[skullet-loading]")).toBeNull();
    animate.mockRestore();
    hidden.mockRestore();
  });

  it("stills bones that have stood 20 s: a window left on a host that does not answer costs no frames", () => {
    const { container } = render(<Region loading hold={0} bones={<Row name="Sample" />} />);
    const drawing = container.querySelector<HTMLElement>("[skullet-loading]")!;
    act(() => void vi.advanceTimersByTime(BONES.sweepCapMs - 1));
    expect(drawing.hasAttribute("data-bones-still")).toBe(false);
    act(() => void vi.advanceTimersByTime(1));
    // The mark sets Skullet's animation to none where the bones read it; the change inside the drawing makes it measure again.
    expect(drawing.hasAttribute("data-bones-still")).toBe(true);
    expect(drawing.querySelector("[skullet-ghost]")!.hasAttribute("data-still")).toBe(true);
  });

  it("never holds bones that follow bones", () => {
    const first = render(<Bones>{<Row name="Sample" />}</Bones>);
    act(() => void vi.advanceTimersByTime(BONES.holdMs));
    const second = render(<Region loading bones={<Row name="Sample" />} />);
    expect(region(second.container).dataset.bones).toBe("shown");
    expect(region(second.container).hasAttribute("data-bones-waited")).toBe(false);
    first.unmount();
  });

  it("holds its bones though a tab parked behind the window still shows some: those are no one's to follow", () => {
    const parked = render(<Bones hold={0}>{<Row name="Sample" />}</Bones>);
    act(() => void vi.advanceTimersByTime(BONES.followsMs + 1));
    // `content-visibility: hidden` on the parked tab: its bones are in the page and drawn nowhere.
    // jsdom has no `checkVisibility`: the engine asks it where the window has it.
    const proto = Element.prototype as { checkVisibility?: () => boolean };
    proto.checkVisibility = function (this: Element) {
      return !parked.container.contains(this);
    };
    const { container } = render(<Region loading bones={<Row name="Sample" />} />);
    expect(region(container).dataset.bones).toBe("held");
    delete proto.checkVisibility;
    parked.unmount();
  });

  it("takes `hold={0}` as bones that show at once", () => {
    const { container } = render(<Region loading hold={0} bones={<Row name="Sample" />} />);
    expect(region(container).dataset.bones).toBe("shown");
  });

  it("says where it lies and whether it fills its parent", () => {
    const { container } = render(<Region loading={false} fill on="stage" className="gap-2" bones={null} />);
    expect(region(container).dataset.bonesOn).toBe("stage");
    expect(region(container).className).toContain("flex-1");
    expect(region(container).className).toContain("gap-2");
  });

  it("leaves out of the drawing what is unseen at rest, and takes a clear border for no surface", () => {
    const { container } = render(
      <Region
        loading
        hold={0}
        bones={
          <div>
            <p data-hover className="invisible">
              Shown on hover
            </p>
            <span data-slot-unset />
            <div data-row style={{ border: "1px solid transparent", paddingTop: "7px" }}>
              One name
            </div>
            <div data-card style={{ border: "1px solid transparent", paddingTop: "7px", backgroundColor: "rgb(30, 30, 30)" }}>
              A card
            </div>
          </div>
        }
      />,
    );
    const drawn = (selector: string) => container.querySelector<HTMLElement>(`[skullet-ghost] ${selector}`)!;
    expect(drawn("[data-hover]").hasAttribute("skullet-ignore")).toBe(true);
    expect(drawn("[data-slot-unset]").hasAttribute("skullet-ignore")).toBe(true);
    // The row keeps its box (the edge's 1px moves into the padding) and is no painted box to Skullet.
    expect(drawn("[data-row]").style.borderTopStyle).toBe("none");
    expect(drawn("[data-row]").style.paddingTop).toBe("8px");
    // A box with a fill of its own is a surface: it is left as it is.
    expect(drawn("[data-card]").style.borderTopStyle).toBe("solid");
    expect(drawn("[data-card]").style.paddingTop).toBe("7px");
  });

  it("tells a piece it is inside bones, so it can skip what a drawing must not do", () => {
    const asked = vi.fn();
    function Piece() {
      const inBones = useInBones();
      useEffect(() => {
        if (!inBones) asked();
      }, [inBones]);
      return <p>{inBones ? "drawn" : "live"}</p>;
    }
    const view = (loading: boolean) => (
      <Region loading={loading} hold={0} bones={<Piece />}>
        <Piece />
      </Region>
    );
    const { container, rerender } = render(view(true));
    expect(container.querySelector("[skullet-ghost]")!.textContent).toBe("drawn");
    expect(asked).not.toHaveBeenCalled();
    rerender(view(false));
    expect(screen.getByText("live")).toBeTruthy();
    expect(asked).toHaveBeenCalledTimes(1);
  });

  it("calls a bones function only while it waits", () => {
    const draw = vi.fn(() => <Row name="Sample" />);
    render(
      <Region loading={false} bones={draw}>
        <Row name="Real" />
      </Region>,
    );
    expect(draw).not.toHaveBeenCalled();
  });
});

describe("Loaded", () => {
  beforeEach(settle);
  const view = (data: string[] | null, failed?: string) => (
    <Loaded data={data} sample={["Sample one", "Sample two"]} failed={failed ? <p role="alert">{failed}</p> : null} hold={0}>
      {(rows) => (
        <ul>
          {rows.map((row) => (
            <li key={row}>{row}</li>
          ))}
        </ul>
      )}
    </Loaded>
  );

  it("draws its bones from the sample and its content from the answer, by the one function", () => {
    const { container, rerender } = render(view(null));
    expect([...container.querySelectorAll("[skullet-ghost] li")].map((li) => li.textContent)).toEqual(["Sample one", "Sample two"]);
    expect(screen.queryByRole("listitem")).toBeNull();
    rerender(view(["Real"]));
    expect(screen.getByRole("listitem").textContent).toBe("Real");
  });

  it("stands the failure in the content's place, with no bones under it", () => {
    const { container } = render(view(null, "The box did not answer"));
    expect(screen.getByRole("alert").textContent).toBe("The box did not answer");
    expect(container.querySelector("[skullet-loading]")).toBeNull();
    expect(region(container).dataset.bones).toBeUndefined();
  });
});

describe("Arrive and Bone", () => {
  beforeEach(settle);

  it("is plain inside a region, whose own reveal brings it in", () => {
    const { container } = render(
      <Region loading={false} bones={null}>
        <Arrive>
          <Row name="Real" />
        </Arrive>
      </Region>,
    );
    expect(container.querySelector("[data-arrive]")).toBeNull();
  });

  it("arrives where bones stand, and is plain where none do", () => {
    const alone = render(
      <Arrive>
        <Row name="Alone" />
      </Arrive>,
    );
    expect(alone.container.querySelector("[data-arrive]")).toBeNull();
    alone.unmount();
    const bones = render(<Bones hold={0}>{<Row name="Sample" />}</Bones>);
    const after = render(
      <Arrive>
        <Row name="After" />
      </Arrive>,
    );
    expect(after.container.querySelector("[data-arrive]")).not.toBeNull();
    bones.unmount();
  });

  it("draws a lone bone as one block at its own size", () => {
    const { container } = render(<Bone width={120} height={64} radius={8} className="rounded-lg" />);
    const bone = container.querySelector<HTMLElement>("[data-bone]")!;
    expect(bone.hasAttribute("skullet-block")).toBe(true);
    expect(bone.getAttribute("aria-hidden")).toBe("true");
    expect(bone.style.width).toBe("120px");
    expect(bone.style.height).toBe("64px");
  });
});

describe("reduced motion", () => {
  beforeEach(settle);

  it("swaps at once: the bones are gone in the commit after the content lands, with no fade to wait on", async () => {
    saveMotionPreference("reduced");
    const animate = vi.spyOn(Element.prototype, "animate");
    const view = (loading: boolean) => (
      <Region loading={loading} hold={0} bones={<Row name="Sample" />}>
        <Row name="Real" />
      </Region>
    );
    const { container, rerender } = render(view(true));
    animate.mockClear();
    rerender(view(false));
    await act(async () => void (await vi.advanceTimersByTimeAsync(0)));
    expect(screen.getByText("Real")).toBeTruthy();
    expect(container.querySelector("[skullet-loading]")).toBeNull();
    // The content's own fills do not fade in either.
    expect(animate.mock.calls.filter(([frames]) => JSON.stringify(frames) === JSON.stringify(BONES.surfaces.keyframes))).toEqual([]);
    animate.mockRestore();
  });
});
