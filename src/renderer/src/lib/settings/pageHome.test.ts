import { describe, expect, it } from "vitest";
import { homeEnvironmentId } from "./pageHome";

describe("homeEnvironmentId", () => {
  const box = { id: "env_box", name: "The box" };
  it("finds the one linked computer of the keeper's name, in any case", () => {
    expect(homeEnvironmentId({ name: "the box" }, [box, { id: "env_mac", name: "Mac" }])).toBe("env_box");
  });
  it("names none when no link has that name, or two do", () => {
    expect(homeEnvironmentId({ name: "The box" }, [{ id: "env_box", name: "Linux box" }])).toBeNull();
    expect(homeEnvironmentId({ name: "The box" }, [box, { id: "env_box2", name: "The box" }])).toBeNull();
    expect(homeEnvironmentId(null, [box])).toBeNull();
  });
});
