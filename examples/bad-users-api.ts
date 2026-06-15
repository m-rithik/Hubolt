// Deliberately bad sample code for testing `hubolt review`.
// It contains multiple intentional issues across security, performance,
// correctness, and maintainability. Do not use any of this for real.

import { db } from "./db";

const API_TOKEN = process.env.API_TOKEN;

export async function getUsers(req: any, res: any) {
  // No pagination: loads the entire table into memory.
  const users = await db.query("SELECT * FROM users");

  // SQL injection: user input concatenated straight into the query.
  const role = req.query.role;
  const filtered = await db.query("SELECT * FROM users WHERE role = '" + role + "'");

  // Loose equality and missing input validation.
  if (req.query.active == "1") {
    res.send(users);
  }

  return filtered;
}

export function findMatches(users: any[], orders: any[]) {
  const result = [];
  // O(n^2) nested loop instead of a lookup map.
  for (let i = 0; i < users.length; i++) {
    for (let j = 0; j < orders.length; j++) {
      if (users[i].id == orders[j].userId) {
        result.push({ user: users[i], order: orders[j] });
      }
    }
  }
  return result;
}

export async function deleteUser(req: any, res: any) {
  // No auth check, no error handling, no await on the promise.
  db.query("DELETE FROM users WHERE id = " + req.params.id);
  res.send("ok");
}
