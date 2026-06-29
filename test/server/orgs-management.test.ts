import Fastify from "fastify";
import { describe, expect, test, vi } from "vitest";
import { registerOrgRoutes } from "../../src/server/routes/orgs.js";
import { generateSessionToken } from "../../src/server/auth/sessions.js";

const HEADERS = { authorization: `Bearer ${["org", "mgmt", "token"].join("_")}` };

function makeDb(authRole: string = "admin") {
  const db: any = {
    apiKey: {
      findUnique: vi.fn(() =>
        Promise.resolve({ id: "auth", orgId: "org_1", org: { id: "org_1" }, role: authRole, expiresAt: null, lastUsedAt: new Date() })
      ),
      update: vi.fn(),
      create: vi.fn((args: any) => Promise.resolve({ id: "k", name: args.data.name, role: args.data.role, expiresAt: args.data.expiresAt, createdAt: new Date() })),
      count: vi.fn().mockResolvedValue(2),
      delete: vi.fn()
    },
    organization: {
      findUnique: vi.fn(() => Promise.resolve({ id: "org_1", name: "local", slug: "local" })),
      update: vi.fn((args: any) => Promise.resolve({ id: "org_1", name: args.data.name, slug: "acme" }))
    },
    user: {
      findUnique: vi.fn(() => Promise.resolve({ id: "u1", email: "admin@local", username: "admin", name: "Admin" })),
      upsert: vi.fn((args: any) => Promise.resolve({ id: "u1", email: args.where.email, name: args.create.name })),
      delete: vi.fn().mockResolvedValue({})
    },
    session: {
      findUnique: vi.fn(() =>
        Promise.resolve({
          id: "s1",
          userId: "u1",
          orgId: "org_1",
          expiresAt: new Date(Date.now() + 60_000),
          lastUsedAt: new Date(),
          user: {
            id: "u1",
            status: "active",
            mustChangePassword: false,
            orgs: [{ orgId: "org_1", role: authRole }]
          }
        })
      ),
      update: vi.fn()
    },
    organizationMember: {
      upsert: vi.fn((args: any) => Promise.resolve({ id: "m1", role: args.create.role })),
      findUnique: vi.fn(() => Promise.resolve({ id: "m1", orgId: "org_1", userId: "u1", role: "viewer" })),
      // The guarded service resolves the member by (orgId, userId) and counts
      // memberships/admins; count >1 keeps the membership-scoped delete path.
      findFirst: vi.fn(() => Promise.resolve({ id: "m1", orgId: "org_1", userId: "u1", role: "viewer" })),
      count: vi.fn().mockResolvedValue(2),
      update: vi.fn((args: any) => Promise.resolve({ id: "m1", role: args.data.role })),
      delete: vi.fn().mockResolvedValue({})
    },
    auditEvent: { create: vi.fn().mockResolvedValue({}) }
  };
  return db;
}

function buildApp(db: any) {
  const app = Fastify({ logger: false });
  registerOrgRoutes(app, { db });
  return app;
}

describe("organization management", () => {
  test("auth/me includes user identity for username/password sessions", async () => {
    const db = makeDb();
    const app = buildApp(db);
    const token = generateSessionToken();
    const res = await app.inject({ method: "GET", url: "/auth/me", headers: { authorization: `Bearer ${token}` } });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      role: "admin",
      org: { id: "org_1", name: "local", slug: "local" },
      user: { id: "u1", username: "admin", name: "Admin" }
    });
    await app.close();
  });

  test("admin renames the organization", async () => {
    const db = makeDb();
    const app = buildApp(db);
    const res = await app.inject({ method: "PATCH", url: "/orgs/current", headers: HEADERS, payload: { name: "New Name" } });
    expect(res.statusCode).toBe(200);
    expect(db.organization.update).toHaveBeenCalledWith(expect.objectContaining({ data: { name: "New Name" } }));
    await app.close();
  });

  test("admin adds a member by email", async () => {
    const db = makeDb();
    const app = buildApp(db);
    const res = await app.inject({ method: "POST", url: "/orgs/current/members", headers: HEADERS, payload: { email: "dev@x.com", role: "reviewer" } });
    expect(res.statusCode).toBe(201);
    expect(db.user.upsert).toHaveBeenCalled();
    expect(db.organizationMember.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ create: expect.objectContaining({ orgId: "org_1", role: "reviewer" }) })
    );
    await app.close();
  });

  test("admin changes and removes a member", async () => {
    const db = makeDb();
    const app = buildApp(db);
    const patch = await app.inject({ method: "PATCH", url: "/orgs/current/members/m1", headers: HEADERS, payload: { role: "admin" } });
    expect(patch.statusCode).toBe(200);
    expect(db.organizationMember.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "m1" }, data: { role: "admin" } }));

    const del = await app.inject({ method: "DELETE", url: "/orgs/current/members/m1", headers: HEADERS });
    expect(del.statusCode).toBe(200);
    expect(db.organizationMember.delete).toHaveBeenCalledWith({ where: { id: "m1" } });
    await app.close();
  });

  test("admin creates a key with an expiry", async () => {
    const db = makeDb();
    const app = buildApp(db);
    const res = await app.inject({ method: "POST", url: "/orgs/current/api-keys", headers: HEADERS, payload: { name: "ci", role: "viewer", expiresInDays: 30 } });
    expect(res.statusCode).toBe(201);
    expect(db.apiKey.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ expiresAt: expect.any(Date) }) })
    );
    await app.close();
  });

  test("admin creates a key owned by a member", async () => {
    const db = makeDb();
    const app = buildApp(db);
    const res = await app.inject({ method: "POST", url: "/orgs/current/api-keys", headers: HEADERS, payload: { name: "alice-key", role: "viewer", memberId: "m1" } });
    expect(res.statusCode).toBe(201);
    expect(db.apiKey.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ memberId: "m1" }) })
    );
    await app.close();
  });

  test("rejects a key owner who is not a member of the org", async () => {
    const db = makeDb();
    db.organizationMember.findUnique = vi.fn(() => Promise.resolve(null));
    const app = buildApp(db);
    const res = await app.inject({ method: "POST", url: "/orgs/current/api-keys", headers: HEADERS, payload: { name: "x", role: "viewer", memberId: "nope" } });
    expect(res.statusCode).toBe(400);
    expect(db.apiKey.create).not.toHaveBeenCalled();
    await app.close();
  });

  test("a viewer cannot rename or manage members", async () => {
    const db = makeDb("viewer");
    const app = buildApp(db);
    expect((await app.inject({ method: "PATCH", url: "/orgs/current", headers: HEADERS, payload: { name: "x" } })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: "/orgs/current/members", headers: HEADERS, payload: { email: "a@b.com" } })).statusCode).toBe(403);
    expect((await app.inject({ method: "DELETE", url: "/orgs/current/members/m1", headers: HEADERS })).statusCode).toBe(403);
    await app.close();
  });
});
