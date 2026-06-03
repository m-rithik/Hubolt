export type ReviewEventType =
  | "review.started"
  | "context.built"
  | "analyzer.completed"
  | "llm.called"
  | "finding.created"
  | "finding.filtered"
  | "review.completed"
  | "comment.posted"
  | "feedback.received"
  | "audit.written";

export type RedactionState = "raw" | "redacted" | "metadataOnly";

export interface ReviewEvent<TPayload = unknown> {
  id: string;
  type: ReviewEventType;
  createdAt: string;
  repo: string;
  pullRequest?: number;
  commitSha?: string;
  actor?: string;
  payload: TPayload;
  redactionState: RedactionState;
}

export function createReviewEvent<TPayload>(
  input: Omit<ReviewEvent<TPayload>, "id" | "createdAt">
): ReviewEvent<TPayload> {
  return {
    ...input,
    id: `evt_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
    createdAt: new Date().toISOString()
  };
}
