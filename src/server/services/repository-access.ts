import type { PrismaClient } from "../../generated/prisma/index.js";
import { UserError } from "./user-management.js";

/**
 * Per-repository access for developers. An admin grants a developer access to
 * specific repos at a level: "read" (view only) or "actions" (view + permitted
 * actions). Admins implicitly access all repos in their org.
 */
export type AccessLevel = "read" | "actions";

function normalizeLevel(level: string | null | undefined): AccessLevel {
  return level === "actions" ? "actions" : "read";
}

export interface RepoAccessEntry {
  repoId: string;
  repoFullName: string;
  provider: string;
  accessLevel: AccessLevel;
}

async function memberFor(db: PrismaClient, orgId: string, userId: string) {
  const member = await db.organizationMember.findFirst({ where: { orgId, userId } });
  if (!member) {
    throw new UserError("User is not a member of this organization", 404);
  }
  return member;
}

/** Repos a user has been granted, with level. */
export async function listUserRepoAccess(db: PrismaClient, orgId: string, userId: string): Promise<RepoAccessEntry[]> {
  const member = await memberFor(db, orgId, userId);
  const rows = await db.repositoryAccess.findMany({
    where: { memberId: member.id },
    include: { repo: { select: { fullName: true, provider: true } } }
  });
  return rows.map((r) => ({
    repoId: r.repoId,
    repoFullName: r.repo.fullName,
    provider: r.repo.provider,
    accessLevel: normalizeLevel(r.accessLevel)
  }));
}

export async function grantRepoAccess(
  db: PrismaClient,
  orgId: string,
  userId: string,
  repoId: string,
  level: AccessLevel,
  grantedById?: string
): Promise<void> {
  const member = await memberFor(db, orgId, userId);
  const repo = await db.repository.findFirst({ where: { id: repoId, orgId }, select: { id: true } });
  if (!repo) {
    throw new UserError("Repository not found in this organization", 404);
  }
  const accessLevel = normalizeLevel(level);
  await db.repositoryAccess.upsert({
    where: { repoId_memberId: { repoId, memberId: member.id } },
    create: { repoId, memberId: member.id, accessLevel, grantedById: grantedById ?? null },
    update: { accessLevel }
  });
}

export async function revokeRepoAccess(db: PrismaClient, orgId: string, userId: string, repoId: string): Promise<void> {
  const member = await memberFor(db, orgId, userId);
  await db.repositoryAccess.deleteMany({ where: { repoId, memberId: member.id } });
}

/** Set of repo ids a developer may access. Admins are unrestricted (caller checks role). */
export async function accessibleRepoIds(db: PrismaClient, orgId: string, userId: string): Promise<Set<string>> {
  const member = await db.organizationMember.findFirst({ where: { orgId, userId } });
  if (!member) return new Set();
  const rows = await db.repositoryAccess.findMany({ where: { memberId: member.id }, select: { repoId: true } });
  return new Set(rows.map((r) => r.repoId));
}

/**
 * Repo ids a caller may read on org-wide read routes: null for admins (no
 * restriction) or an explicit list for developers (their granted repos). Apply
 * to every read route alongside the orgId filter.
 */
export async function readableRepoIds(
  db: PrismaClient,
  orgId: string,
  userId: string | undefined,
  admin: boolean
): Promise<string[] | null> {
  // Unrestricted for admins and for org-level API keys (no session user). Repo
  // scoping applies only to session-authenticated developers with grants.
  if (admin || !userId) return null;
  return [...(await accessibleRepoIds(db, orgId, userId))];
}
