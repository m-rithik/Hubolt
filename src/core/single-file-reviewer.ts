import { readFileSync } from "node:fs";
import type { BuiltContext, ReviewFile } from "./context-builder.js";

export interface SingleFileReviewOptions {
  filepath: string;
  cwd: string;
}

export function buildSingleFileContext(options: SingleFileReviewOptions): BuiltContext {
  const { filepath, cwd } = options;
  const fileContent = readFileSync(filepath, "utf8");
  const fileSize = Buffer.byteLength(fileContent, "utf8");
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
    cwd,
    scope: "file",
    reviewable: [file],
    allFiles: [{ path: filepath, size: fileSize }],
    addedFiles: [filepath],
    deletedFiles: [],
    renamedFiles: [],
    skipped: [],
    diffSize: fileSize
  } as any;
}
