import { readFileSync } from "node:fs";
import type { BuiltContext, ReviewFile } from "./context-builder.js";

export interface SingleFileReviewOptions {
  filepath: string;
  cwd: string;
}

export function buildSingleFileContext(options: SingleFileReviewOptions): BuiltContext {
  const { filepath } = options;
  const fileContent = readFileSync(filepath, "utf8");
  const lineCount = fileContent.split("\n").length;

  const file: ReviewFile = {
    path: filepath,
    status: "modified",
    content: fileContent,
    changedRanges: [
      {
        startLine: 1,
        endLine: lineCount
      }
    ]
  };

  return {
    scope: "file",
    files: [file],
    reviewable: [file]
  };
}
