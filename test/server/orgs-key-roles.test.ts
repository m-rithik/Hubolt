import Fastify from "fastify";
import { describe, expect, test, vi } from "vitest";
import { registerOrgRoutes } from "../../src/server/routes/orgs.js";

const TOKEN = ["org", "key", "token"].join("_");
const HEADERS = { authorization: `Bearer ${TOKEN}` };

function makeDb(opts: { authRole?: string; target?: any; adminCount?: number } = {}) {
  const authRole = opts.authRole ?? "admin";
  const target = opts.target ?? { id: "k2", orgId: "org_1", name: "ci", role: "viewer" };
  const adminCount = opts.adminCount ?? 2;

  const db: any = {
    apiKey: {
      findUnique: vi.fn((args: any) =>
        args.where.keyHash
          ? Promise.resolve({ id: "auth", orgId: "org_1", org: { id: "org_1" }, role: authRole, expiresAt: null, lastUsedAt: new Date() })
          : Promise.resolve(target && target.id === args.where.id ? target : null)
      ),
      count: vi.fn().mockResolvedValue(adminCount),
      update: vi.fn((args: any) => Promise.resolve({ id: args.where.id, name: target.name, role: args.data.role ?? target.role, memberId: args.data.memberId ?? null })),
      delete: vi.fn().mockResolvedValue({})
    },
    organizationMember: {
      findUnique: vi.fn(() => Promise.resolve({ id: "m1", orgId: "org_1" }))
    },
    auditEvent: { create: vi.fn().mockResolvedValue({}) }
  };
  // The demote/delete guards run in a transaction and count admin rows with a
  // FOR UPDATE lock; the lock query returns one row per admin.
  db.$queryRaw = vi.fn(async () => Array.from({ length: adminCount }, (_, i) => ({ id: `admin_${i}` })));
  db.$transaction = vi.fn(async (callback: any) => callback(db));
  return db;
}

function buildApp(db: any) {
  const app = Fastify({ logger: false });
  registerOrgRoutes(app, { db });
  return app;
}

describe("api key role management", () => {
  test("admin promotes a viewer key to admin", async () => {
    const db = makeDb();
    const app = buildApp(db);

    const res = await app.inject({ method: "PATCH", url: "/orgs/current/api-keys/k2", headers: HEADERS, payload: { role: "admin" } });

    expect(res.statusCode).toBe(200);
    expect(db.apiKey.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "k2" }, data: { role: "admin" } }));
    expect(db.auditEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: "api_key.role_changed" }) })
    );
    await app.close();
  });

  test("cannot demote the last admin key", async () => {
    const db = makeDb({ target: { id: "k2", orgId: "org_1", name: "only-admin", role: "admin" }, adminCount: 1 });
    const app = buildApp(db);

    const res = await app.inject({ method: "PATCH", url: "/orgs/current/api-keys/k2", headers: HEADERS, payload: { role: "viewer" } });

    expect(res.statusCode).toBe(400);
    expect(db.apiKey.update).not.toHaveBeenCalled();
    await app.close();
  });

  test("cannot remove the last admin key", async () => {
    const db = makeDb({ target: { id: "k2", orgId: "org_1", name: "only-admin", role: "admin" }, adminCount: 1 });
    const app = buildApp(db);

    const res = await app.inject({ method: "DELETE", url: "/orgs/current/api-keys/k2", headers: HEADERS });

    expect(res.statusCode).toBe(400);
    expect(db.apiKey.delete).not.toHaveBeenCalled();
    await app.close();
  });

  test("demoting an admin key locks the admin rows inside a transaction", async () => {
    const db = makeDb({ target: { id: "k2", orgId: "org_1", name: "second-admin", role: "admin" }, adminCount: 2 });
    const app = buildApp(db);

    const res = await app.inject({ method: "PATCH", url: "/orgs/current/api-keys/k2", headers: HEADERS, payload: { role: "viewer" } });

    expect(res.statusCode).toBe(200);
    // The guard and the mutation share one transaction, and the last-admin
    // count is taken under a FOR UPDATE lock so concurrent demotions serialize.
    expect(db.$transaction).toHaveBeenCalled();
    expect(db.$queryRaw).toHaveBeenCalled();
    expect(db.apiKey.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "k2" }, data: { role: "viewer" } })
    );
    await app.close();
  });

  test("admin assigns a key to a member", async () => {
    const db = makeDb();
    const app = buildApp(db);

    const res = await app.inject({ method: "PATCH", url: "/orgs/current/api-keys/k2", headers: HEADERS, payload: { memberId: "m1" } });

    expect(res.statusCode).toBe(200);
    expect(db.apiKey.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "k2" }, data: { memberId: "m1" } }));
    await app.close();
  });

  test("a viewer key cannot change roles or remove keys", async () => {
    const db = makeDb({ authRole: "viewer" });
    const app = buildApp(db);

    const patch = await app.inject({ method: "PATCH", url: "/orgs/current/api-keys/k2", headers: HEADERS, payload: { role: "admin" } });
    expect(patch.statusCode).toBe(403);

    const del = await app.inject({ method: "DELETE", url: "/orgs/current/api-keys/k2", headers: HEADERS });
    expect(del.statusCode).toBe(403);
    await app.close();
  });
});
