const COMMENT_MARKER = "<!-- hubolt-review-comment -->";
const RATE_LIMIT_THRESHOLD = 10;

class GitHubCommentManager {
  constructor(octokit, owner, repo, issueNumber) {
    this.octokit = octokit;
    this.owner = owner;
    this.repo = repo;
    this.issueNumber = issueNumber;
  }

  async findExistingComment() {
    try {
      const comments = await this.getAllComments();
      return comments.find((c) => c.body.includes(COMMENT_MARKER));
    } catch (error) {
      console.error("Error finding existing comment:", error.message);
      throw error;
    }
  }

  async getAllComments() {
    const comments = [];
    let page = 1;

    try {
      while (true) {
        const response = await this.octokit.rest.issues.listComments({
          owner: this.owner,
          repo: this.repo,
          issue_number: this.issueNumber,
          per_page: 100,
          page
        });

        if (response.data.length === 0) break;

        comments.push(...response.data);

        if (response.data.length < 100) break;
        page++;
      }
    } catch (error) {
      console.error("Error listing comments:", error.message);
      throw error;
    }

    return comments;
  }

  async createComment(body) {
    const fullBody = `${body}\n\n${COMMENT_MARKER}`;

    try {
      const response = await this.octokit.rest.issues.createComment({
        owner: this.owner,
        repo: this.repo,
        issue_number: this.issueNumber,
        body: fullBody
      });

      return response.data;
    } catch (error) {
      console.error("Error creating comment:", error.message);
      throw error;
    }
  }

  async updateComment(commentId, body) {
    const fullBody = `${body}\n\n${COMMENT_MARKER}`;

    try {
      const response = await this.octokit.rest.issues.updateComment({
        owner: this.owner,
        repo: this.repo,
        comment_id: commentId,
        body: fullBody
      });

      return response.data;
    } catch (error) {
      console.error("Error updating comment:", error.message);
      throw error;
    }
  }

  async checkRateLimit() {
    try {
      const response = await this.octokit.rest.rateLimit.get();
      const remaining = response.data?.rate?.remaining;
      if (typeof remaining === "number" && remaining < RATE_LIMIT_THRESHOLD) {
        console.warn(
          `GitHub API rate limit low: ${remaining} requests remaining`
        );
        return false;
      }
    } catch (error) {
      console.warn("Could not check GitHub API rate limit:", error.message);
    }

    return true;
  }
}

function sanitizeCacheKey(ref) {
  return ref
    .replace(/\//g, "-")
    .replace(/[^a-zA-Z0-9._\-]/g, "_")
    .substring(0, 200);
}

function validateGitRef(ref) {
  if (!ref || typeof ref !== "string") {
    throw new Error("Invalid git ref: must be non-empty string");
  }
  if (ref.includes("..") || ref.includes("\\") || ref.includes("$")) {
    throw new Error("Invalid git ref: contains dangerous characters");
  }
  return true;
}

function exponentialBackoff(baseDelayMs, maxAttempts) {
  return async (fn) => {
    let lastError;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        return await fn();
      } catch (error) {
        lastError = error;

        if (attempt < maxAttempts - 1) {
          const delayMs = baseDelayMs * Math.pow(2, attempt);
          console.warn(
            `Attempt ${attempt + 1} failed, retrying in ${delayMs}ms:`,
            error.message
          );
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
      }
    }

    throw lastError;
  };
}

module.exports = {
  GitHubCommentManager,
  sanitizeCacheKey,
  validateGitRef,
  exponentialBackoff,
  COMMENT_MARKER
};
