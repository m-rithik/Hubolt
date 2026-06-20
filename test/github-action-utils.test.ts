import { createRequire } from "node:module";
import { describe, expect, test, vi } from "vitest";

const require = createRequire(import.meta.url);
const { GitHubCommentManager, COMMENT_MARKER } = require("../.github/actions/review/utils.cjs");

describe("GitHubCommentManager", () => {
  test("propagates comment lookup errors so retry wrappers can retry", async () => {
    const error = new Error("temporary GitHub failure");
    const octokit = {
      rest: {
        issues: {
          listComments: vi.fn().mockRejectedValue(error)
        }
      }
    };
    const manager = new GitHubCommentManager(octokit, "owner", "repo", 1);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(manager.findExistingComment()).rejects.toThrow("temporary GitHub failure");
    expect(octokit.rest.issues.listComments).toHaveBeenCalledOnce();

    log.mockRestore();
  });

  test("ignores comments with no body when finding the marker", async () => {
    const octokit = {
      rest: {
        issues: {
          listComments: vi.fn().mockResolvedValue({
            data: [
              { id: 1, body: null },
              { id: 2, body: `report\n\n${COMMENT_MARKER}`, user: { type: "Bot", login: "github-actions[bot]" } }
            ]
          })
        }
      }
    };
    const manager = new GitHubCommentManager(octokit, "owner", "repo", 1);

    const found = await manager.findExistingComment();
    expect(found?.id).toBe(2);
  });

  test("does not adopt a marker comment posted by an untrusted PR participant", async () => {
    const octokit = {
      rest: {
        issues: {
          listComments: vi.fn().mockResolvedValue({
            data: [
              { id: 1, body: `spoof\n\n${COMMENT_MARKER}`, user: { type: "User", login: "mallory" }, author_association: "CONTRIBUTOR" },
              { id: 2, body: `real report\n\n${COMMENT_MARKER}`, user: { type: "Bot", login: "github-actions[bot]" }, author_association: "NONE" }
            ]
          })
        }
      }
    };
    const manager = new GitHubCommentManager(octokit, "owner", "repo", 1);

    const found = await manager.findExistingComment();
    expect(found?.id).toBe(2);
  });

  test("ignores a lone marker comment from an untrusted author", async () => {
    const octokit = {
      rest: {
        issues: {
          listComments: vi.fn().mockResolvedValue({
            data: [{ id: 1, body: `spoof\n\n${COMMENT_MARKER}`, user: { type: "User", login: "mallory" }, author_association: "NONE" }]
          })
        }
      }
    };
    const manager = new GitHubCommentManager(octokit, "owner", "repo", 1);

    expect(await manager.findExistingComment()).toBeUndefined();
  });

  test("adopts a marker comment from a repo maintainer (PAT-based posting)", async () => {
    const octokit = {
      rest: {
        issues: {
          listComments: vi.fn().mockResolvedValue({
            data: [{ id: 9, body: `report\n\n${COMMENT_MARKER}`, user: { type: "User", login: "maintainer" }, author_association: "MEMBER" }]
          })
        }
      }
    };
    const manager = new GitHubCommentManager(octokit, "owner", "repo", 1);

    expect((await manager.findExistingComment())?.id).toBe(9);
  });

  test("checks the GitHub rate limit endpoint", async () => {
    const octokit = {
      rest: {
        rateLimit: {
          get: vi.fn().mockResolvedValue({ data: { rate: { remaining: 42 } } })
        }
      }
    };
    const manager = new GitHubCommentManager(octokit, "owner", "repo", 1);

    await expect(manager.checkRateLimit()).resolves.toBe(true);
    expect(octokit.rest.rateLimit.get).toHaveBeenCalledOnce();
  });

  test("returns false when the GitHub rate limit is below threshold", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const octokit = {
      rest: {
        rateLimit: {
          get: vi.fn().mockResolvedValue({ data: { rate: { remaining: 5 } } })
        }
      }
    };
    const manager = new GitHubCommentManager(octokit, "owner", "repo", 1);

    await expect(manager.checkRateLimit()).resolves.toBe(false);
    expect(warn).toHaveBeenCalledWith("GitHub API rate limit low: 5 requests remaining");

    warn.mockRestore();
  });
});
