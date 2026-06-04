import { describe, expect, test } from "vitest";
import { grammarKeyForPath, mapChangedRegions } from "../../src/core/semantic-map.js";

const source = [
  "export async function getUsers(req, res) {", // 1
  "  const users = await User.find();", //          2
  "  return users;", //                             3
  "}", //                                           4
  "", //                                            5
  "export const Widget = () => {", //               6
  "  return null;", //                              7
  "};", //                                          8
  "class UserService {", //                         9
  "  remove(id) { return id; }", //                10
  "}" //                                           11
].join("\n");

describe("semantic-map", () => {
  test("maps file extensions to grammar keys", () => {
    expect(grammarKeyForPath("a.ts")).toBe("ts");
    expect(grammarKeyForPath("a.tsx")).toBe("tsx");
    expect(grammarKeyForPath("a.js")).toBe("js");
    expect(grammarKeyForPath("a.md")).toBeNull();
  });

  test("returns regions overlapping the changed range", async () => {
    const regions = await mapChangedRegions(source, "src/a.ts", [{ startLine: 2, endLine: 2 }]);
    const names = regions.map((region) => region.name);

    expect(names).toContain("getUsers");
    expect(names).not.toContain("UserService");
  });

  test("detects functions, arrow consts, classes, and methods across the file", async () => {
    const regions = await mapChangedRegions(source, "src/a.ts", [{ startLine: 1, endLine: 11 }]);
    const names = regions.map((region) => region.name);

    expect(names).toEqual(expect.arrayContaining(["getUsers", "Widget", "UserService", "remove"]));
  });

  test("returns empty for unsupported file types", async () => {
    expect(await mapChangedRegions("# heading", "README.md", [{ startLine: 1, endLine: 1 }])).toEqual([]);
  });
});
