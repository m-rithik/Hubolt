import { describe, expect, test } from "vitest";
import { parseUnifiedDiff } from "../../src/providers/scm/bitbucket/client.js";
import { buildFileDiffIndex } from "../../src/github/line-mapping.js";

const diff = `diff --git a/src/foo.ts b/src/foo.ts
index 1111111..2222222 100644
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,3 +1,4 @@
 const a = 1;
-const b = 2;
+const b = 3;
+const c = 4;
 const d = 5;
diff --git a/new.txt b/new.txt
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/new.txt
@@ -0,0 +1,2 @@
+hello
+world
diff --git a/gone.txt b/gone.txt
deleted file mode 100644
index 4444444..0000000
--- a/gone.txt
+++ /dev/null
@@ -1 +0,0 @@
-bye
`;

describe("parseUnifiedDiff", () => {
  const files = parseUnifiedDiff(diff);

  test("splits per file with paths and status", () => {
    expect(files.map((f) => f.filename)).toEqual(["src/foo.ts", "new.txt", "gone.txt"]);
    expect(files.map((f) => f.status)).toEqual(["modified", "added", "removed"]);
  });

  test("per-file patch feeds the shared line-mapping index", () => {
    const idx = buildFileDiffIndex(files[0].patch!);
    // New-file added lines are 2 and 3 within the hunk; line 1 is context.
    expect(idx.addedLines.has(2)).toBe(true);
    expect(idx.addedLines.has(3)).toBe(true);
    expect(idx.rightLines.has(1)).toBe(true);
  });

  test("returns nothing for an empty diff", () => {
    expect(parseUnifiedDiff("")).toEqual([]);
  });
});
