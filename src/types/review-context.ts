import type { AnalyzerSignal } from "./providers.js";

export interface PullRequestContext {
  provider: "github" | "gitlab" | "bitbucket";
  owner: string;
  repo: string;
  number: number;
  title: string;
  body?: string;
}

export interface ChangedFileContext {
  path: string;
  status: "added" | "modified" | "deleted" | "renamed";
  language?: string;
  content?: string;
}

export interface ReviewBudget {
  maxContextTokens: number;
  commentBudget: number;
}

export interface KnowledgeContext {
  files: string[];
  notes: string[];
}

export interface ReviewContext {
  repoRoot: string;
  repoName?: string;
  baseRef?: string;
  headRef?: string;
  commitSha?: string;
  pullRequest?: PullRequestContext;
  changedFiles: ChangedFileContext[];
  analyzerSignals: AnalyzerSignal[];
  knowledge: KnowledgeContext;
  budget: ReviewBudget;
}
