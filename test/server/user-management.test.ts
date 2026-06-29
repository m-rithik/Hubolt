import { describe, expect, test, vi } from "vitest";
import {
  deleteOrgUser,
  resetUserPassword,
  setUserStatus,
  UserError
} from "../../src/server/services/user-management.js";

function db(opts: { role?: string; memberships: number }) {
  return {
    organizationMember: {
      findFirst: vi.fn().mockResolvedValue({ id: "m1", orgId: "orgA", userId: "u1", role: opts.role ?? "developer" }),
      count: vi.fn().mockResolvedValue(opts.memberships),
      delete: vi.fn().mockResolvedValue({})
    },
    user: { delete: vi.fn().mockResolvedValue({}), update: vi.fn().mockResolvedValue({}) },
    session: { deleteMany: vi.fn().mockResolvedValue({}) }
  } as never;
}

describe("user lifecycle is membership-scoped (Finding #2)", () => {
  test("deleting a user with a single membership removes the account", async () => {
    const d = db({ memberships: 1 });
    await deleteOrgUser(d, "orgA", "u1");
    expect((d as any).user.delete).toHaveBeenCalledOnce();
    expect((d as any).organizationMember.delete).not.toHaveBeenCalled();
  });

  test("deleting a user shared with another org removes only this org's membership", async () => {
    const d = db({ memberships: 2 });
    await deleteOrgUser(d, "orgA", "u1");
    expect((d as any).organizationMember.delete).toHaveBeenCalledWith({ where: { id: "m1" } });
    expect((d as any).user.delete).not.toHaveBeenCalled();
  });

  test("resetting the password of a multi-org user is refused", async () => {
    const d = db({ memberships: 2 });
    await expect(resetUserPassword(d, "orgA", "u1", "a-strong-password")).rejects.toBeInstanceOf(UserError);
    expect((d as any).user.update).not.toHaveBeenCalled();
  });

  test("disabling a multi-org user is refused", async () => {
    const d = db({ memberships: 2 });
    await expect(setUserStatus(d, "orgA", "u1", "disabled")).rejects.toBeInstanceOf(UserError);
  });
});
