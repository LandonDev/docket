import { describe, expect, it } from "vitest";
import { jobNameOf } from "./jobName";

const ws = (sector: string, name: string, environmentId = "box", kind = "work") => ({ kind, sector, name, environmentId }) as never;

describe("a job's name", () => {
  it("is its Work workspace's name, never the sector's word", () => {
    expect(jobNameOf("purdue", [ws("purdue", "Purdue Esports")])).toBe("Purdue Esports");
    expect(jobNameOf("ref", [ws("ref", "Refereeing"), ws("purdue", "Purdue Esports")])).toBe("Refereeing");
  });

  it("takes the one on the home host when two hosts hold the sector", () => {
    expect(jobNameOf("purdue", [ws("purdue", "Purdue (Mac)", "mac"), ws("purdue", "Purdue Esports", "box")], "box")).toBe("Purdue Esports");
  });

  it("falls back to the sector's word only where no Work workspace holds it", () => {
    expect(jobNameOf("ref", [ws("ref", "ref code", "box", "code")])).toBe("Ref");
    expect(jobNameOf("unify", [])).toBe("Unify");
  });
});
