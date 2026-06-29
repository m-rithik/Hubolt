import type { PrismaClient } from "../../generated/prisma/index.js";
import { hashPassword } from "../auth/passwords.js";

/** Admin-facing user + membership management for the two-role model. */

export class UserError extends Error {
  constructor(message: string, public statusCode = 400) {
    super(message);
    this.name = "UserError";
  }
}

export type Role = "admin" | "developer";

function normalizeRole(role: string | null | undefined): Role {
  return role === "admin" ? "admin" : "developer";
}

export interface OrgUser {
  memberId: string;
  userId: string;
  username: string | null;
  name: string | null;
  role: Role;
  status: string;
  createdAt: Date;
}

export async function listOrgUsers(db: PrismaClient, orgId: string): Promise<OrgUser[]> {
  const members = await db.organizationMember.findMany({
    where: { orgId },
    include: { user: true },
    orderBy: { createdAt: "asc" }
  });
  return members.map((m) => ({
    memberId: m.id,
    userId: m.userId,
    username: m.user.username,
    name: m.user.name,
    role: normalizeRole(m.role),
    status: m.user.status,
    createdAt: m.createdAt
  }));
}

export interface NewUser {
  username: string;
  password: string;
  role: Role;
  name?: string;
}

export async function createOrgUser(db: PrismaClient, orgId: string, input: NewUser): Promise<OrgUser> {
  const role = normalizeRole(input.role);
  const existing = await db.user.findUnique({ where: { username: input.username }, select: { id: true } });
  if (existing) {
    throw new UserError("Username is already taken", 409);
  }
  return db.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: {
        email: `${input.username}@local`,
        username: input.username,
        name: input.name ?? input.username,
        passwordHash: hashPassword(input.password),
        status: "active"
      }
    });
    const member = await tx.organizationMember.create({ data: { orgId, userId: user.id, role } });
    return {
      memberId: member.id,
      userId: user.id,
      username: user.username,
      name: user.name,
      role,
      status: user.status,
      createdAt: member.createdAt
    };
  });
}

export async function resetUserPassword(db: PrismaClient, orgId: string, userId: string, newPassword: string): Promise<void> {
  await assertMember(db, orgId, userId);
  // passwordHash is a global account field; refuse to change it for a user who
  // belongs to other organizations (would affect those tenants).
  await assertSingleOrg(db, orgId, userId, "reset the password of");
  await db.user.update({
    where: { id: userId },
    data: { passwordHash: hashPassword(newPassword), mustChangePassword: true }
  });
  await db.session.deleteMany({ where: { userId } });
}

export async function setUserRole(db: PrismaClient, orgId: string, userId: string, role: Role): Promise<void> {
  const member = await assertMember(db, orgId, userId);
  const next = normalizeRole(role);
  if (member.role === "admin" && next !== "admin") {
    await assertNotLastAdmin(db, orgId);
  }
  await db.organizationMember.update({ where: { id: member.id }, data: { role: next } });
}

export async function setUserStatus(db: PrismaClient, orgId: string, userId: string, status: string): Promise<void> {
  const member = await assertMember(db, orgId, userId);
  const next = status === "disabled" ? "disabled" : "active";
  if (next === "disabled" && member.role === "admin") {
    await assertNotLastAdmin(db, orgId);
  }
  // status is a global account field; refuse to flip it for a multi-org user.
  await assertSingleOrg(db, orgId, userId, "change the status of");
  await db.user.update({ where: { id: userId }, data: { status: next } });
  if (next === "disabled") {
    await db.session.deleteMany({ where: { userId } });
  }
}

/**
 * Remove the user FROM THIS ORG. Deleting the membership (not the global user)
 * is the default, so a user shared with another org keeps that access. The
 * global account is deleted only when this was the user's sole membership.
 */
export async function deleteOrgUser(db: PrismaClient, orgId: string, userId: string): Promise<void> {
  const member = await assertMember(db, orgId, userId);
  if (member.role === "admin") {
    await assertNotLastAdmin(db, orgId);
  }
  const memberships = await db.organizationMember.count({ where: { userId } });
  if (memberships <= 1) {
    // Sole membership: removing it would orphan the account; delete the user
    // (cascades membership, sessions, repository access).
    await db.user.delete({ where: { id: userId } });
  } else {
    // Shared account: only this org's membership (and its repo access via
    // cascade) is removed; other orgs and the global account are untouched.
    await db.organizationMember.delete({ where: { id: member.id } });
  }
}

async function assertMember(db: PrismaClient, orgId: string, userId: string) {
  const member = await db.organizationMember.findFirst({ where: { orgId, userId } });
  if (!member) {
    throw new UserError("User is not a member of this organization", 404);
  }
  return member;
}

/** Guard global-account mutations: only allowed when the user has no other org. */
async function assertSingleOrg(db: PrismaClient, orgId: string, userId: string, action: string): Promise<void> {
  const memberships = await db.organizationMember.count({ where: { userId } });
  if (memberships > 1) {
    throw new UserError(`Cannot ${action} a user who belongs to other organizations`, 409);
  }
}

async function assertNotLastAdmin(db: PrismaClient, orgId: string): Promise<void> {
  const admins = await db.organizationMember.count({ where: { orgId, role: "admin" } });
  if (admins <= 1) {
    throw new UserError("Cannot remove or demote the last admin", 409);
  }
}
