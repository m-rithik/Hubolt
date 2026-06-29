import Fastify from "fastify";
import { afterEach, describe, expect, test, vi } from "vitest";
import { registerAuthRoutes } from "../../src/server/routes/auth.js";
import { hashPassword } from "../../src/server/auth/passwords.js";
import { _resetThrottle } from "../../src/server/auth/login-throttle.js";

const PASSWORD = "correct horse battery staple";

function userWithTwoOrgs() {
  return {
    id: "user_1",
    username: "alex",
    passwordHash: hashPassword(PASSWORD),
    status: "active",
    mustChangePassword: false,
    name: "Alex",
    orgs: [
      { orgId: "org_a", role: "developer", org: { id: "org_a", name: "Org A", slug: "org-a" } },
      { orgId: "org_b", role: "admin", org: { id: "org_b", name: "Org B", slug: "org-b" } }
    ]
  };
}

function makeDb() {
  return {
    user: {
      findUnique: vi.fn().mockResolvedValue(userWithTwoOrgs()),
      update: vi.fn()
    },
    session: {
      create: vi.fn().mockResolvedValue({ id: "session_1" }),
      deleteMany: vi.fn()
    },
    auditEvent: {
      create: vi.fn().mockResolvedValue({})
    }
  } as any;
}

describe("auth routes", () => {
  afterEach(() => {
    _resetThrottle();
  });

  test("multi-org login requires explicit organization selection", async () => {
    const app = Fastify({ logger: false });
    const db = makeDb();
    registerAuthRoutes(app, { db });

    const response = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { username: "alex", password: PASSWORD }
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      error: "Organization selection required",
      organizations: [
        { id: "org_a", slug: "org-a", role: "developer" },
        { id: "org_b", slug: "org-b", role: "admin" }
      ]
    });
    expect(db.session.create).not.toHaveBeenCalled();
    await app.close();
  });

  test("session is stored with the selected organization", async () => {
    const app = Fastify({ logger: false });
    const db = makeDb();
    registerAuthRoutes(app, { db });

    const response = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { username: "alex", password: PASSWORD, orgId: "org_b" }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ role: "admin", org: { id: "org_b", slug: "org-b" } });
    expect(db.session.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ userId: "user_1", orgId: "org_b" })
      })
    );
    expect(db.auditEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ orgId: "org_b", action: "auth.login" }) })
    );
    await app.close();
  });
});
