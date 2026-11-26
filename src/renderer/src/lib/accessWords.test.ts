import { describe, expect, it } from "vitest";
import { ACCESS_LABEL, ACCESS_LINE } from "./settings/access";
import { PERMISSION_HINTS, PERMISSION_LABELS } from "./tcserver/defaults";

// The composer's Access picker says its words from lib/session.ts (`RUNTIME_MODE_LABEL`, `RUNTIME_MODE_HINT`, in the
// first paint); Settings keeps a copy in lib/settings/access.ts until it imports these. Until then the two stay equal.
describe("Access, in the composer and in Settings", () => {
  it("names each level and says its line in one set of words", () => {
    expect(PERMISSION_LABELS).toEqual(ACCESS_LABEL);
    expect(PERMISSION_HINTS).toEqual(ACCESS_LINE);
  });
});
