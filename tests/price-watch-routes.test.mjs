import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { createPriceWatch, getPriceWatch } from "../app/api/price-watch/route.ts";
import {
  getPriceWatchHistory,
  patchPriceWatcher,
  removePriceWatcher,
} from "../app/api/price-watch/[watcherId]/route.ts";
import {
  getPriceWatchNotifications,
  markPriceWatchNotificationsRead,
} from "../app/api/price-watch/notifications/route.ts";
import {
  PRICE_WATCH_MATCH_ID,
  PRICE_WATCH_NOW,
  PRICE_WATCH_PUBLIC_ID,
  PRICE_WATCH_WORKSPACE_ID,
  accountFor,
  addPriceWatchReport,
  openPriceWatchFixture,
} from "./helpers/price-watch-fixture.mjs";

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "market-signal-price-watch-route-"));
  const path = join(directory, "fixture.sqlite");
  const database = openPriceWatchFixture(path);
  addPriceWatchReport(database);
  database.close();
  const openDatabase = async () => openPriceWatchFixture(path);
  return { directory, path, openDatabase };
}

function services(openDatabase, authorize = async () => accountFor()) {
  return { enabled: () => true, authorize, openDatabase, now: () => PRICE_WATCH_NOW };
}

function activationRequest(body, origin = "https://signal.example") {
  return new Request("https://signal.example/api/price-watch", {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify(body),
  });
}

test("activation resolves only owned persisted match facts and ignores client target claims", async () => {
  const item = fixture();
  try {
    const response = await createPriceWatch(activationRequest({
      publicReportId: PRICE_WATCH_PUBLIC_ID,
      matchId: PRICE_WATCH_MATCH_ID,
      cadence: "daily",
      canonicalUrl: "https://attacker.example/not-the-saved-product",
      amount: 0.01,
    }), services(item.openDatabase));
    assert.equal(response.status, 201);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.equal(response.headers.get("vary"), "Cookie");
    const body = await response.json();
    assert.equal(body.created, 1);

    const database = openPriceWatchFixture(item.path);
    const watcher = database.prepare(`SELECT canonical_url, source_domain, product_name FROM price_watchers WHERE id = ?`).get(body.watcherIds[0]);
    assert.deepEqual(watcher, {
      canonical_url: "https://rival.example/products/tea?sku=server",
      source_domain: "rival.example",
      product_name: "Rival tea 500g",
    });
    database.close();
  } finally { rmSync(item.directory, { recursive: true, force: true }); }
});

test("activation fails closed for cross-origin, non-member, legacy, expired, and unpriced selections", async () => {
  const item = fixture();
  try {
    const body = { publicReportId: PRICE_WATCH_PUBLIC_ID, matchId: PRICE_WATCH_MATCH_ID, cadence: "daily" };
    const crossOrigin = await createPriceWatch(activationRequest(body, "https://evil.example"), services(item.openDatabase));
    assert.equal(crossOrigin.status, 403);
    const missingOrigin = await createPriceWatch(activationRequest(body, ""), services(item.openDatabase));
    assert.equal(missingOrigin.status, 403);
    const oversized = await createPriceWatch(activationRequest({ ...body, padding: "x".repeat(5_000) }), services(item.openDatabase));
    assert.equal(oversized.status, 400);

    const nonMember = await createPriceWatch(activationRequest(body), services(item.openDatabase, async () => accountFor("workspace-other", "user-other", "other@example.com")));
    assert.equal(nonMember.status, 404);

    const database = openPriceWatchFixture(item.path);
    addPriceWatchReport(database, { publicId: "b".repeat(32), runId: "run-legacy", matchId: "2".repeat(64), workspaceId: "" });
    addPriceWatchReport(database, { publicId: "c".repeat(32), runId: "run-expired", matchId: "3".repeat(64), expiresAt: "2026-08-24T11:59:59.000Z" });
    addPriceWatchReport(database, { publicId: "d".repeat(32), runId: "run-unpriced", matchId: "4".repeat(64), priceSignals: [], priceEligible: false });
    database.close();

    for (const [publicReportId, matchId, status] of [
      ["b".repeat(32), "2".repeat(64), 404],
      ["c".repeat(32), "3".repeat(64), 404],
      ["d".repeat(32), "4".repeat(64), 409],
    ]) {
      const response = await createPriceWatch(activationRequest({ publicReportId, matchId, cadence: "daily" }), services(item.openDatabase));
      assert.equal(response.status, status);
      assert.equal(response.headers.get("cache-control"), "private, no-store");
    }
  } finally { rmSync(item.directory, { recursive: true, force: true }); }
});

test("watcher list, history, mutations, deletion, and notifications stay inside the authenticated workspace", async () => {
  const item = fixture();
  try {
    const create = await createPriceWatch(activationRequest({ publicReportId: PRICE_WATCH_PUBLIC_ID, matchId: PRICE_WATCH_MATCH_ID, cadence: "daily" }), services(item.openDatabase));
    const watcherId = (await create.json()).watcherIds[0];

    const unauthenticated = await getPriceWatch(new Request("https://signal.example/api/price-watch"), services(item.openDatabase, async () => null));
    assert.equal(unauthenticated.status, 401);
    const list = await getPriceWatch(new Request("https://signal.example/api/price-watch"), services(item.openDatabase));
    assert.equal(list.status, 200);
    assert.equal((await list.json()).watchers.length, 1);

    const database = openPriceWatchFixture(item.path);
    database.prepare(`INSERT INTO "user" (id, name, email) VALUES ('user-2', 'Member', 'member@example.com')`).run();
    database.prepare(`INSERT INTO workspace_members (workspace_id, user_id, role, created_at) VALUES (?, 'user-2', 'member', ?)`)
      .run(PRICE_WATCH_WORKSPACE_ID, PRICE_WATCH_NOW.toISOString());
    database.prepare(`INSERT INTO workspace_notifications (id, workspace_id, watcher_id, notification_type, title, body, dedupe_key, created_at) VALUES ('notification-1', ?, ?, 'price-decreased', 'Price changed', 'GBP 12.50 to GBP 10', 'route-test', ?)`)
      .run(PRICE_WATCH_WORKSPACE_ID, watcherId, PRICE_WATCH_NOW.toISOString());
    database.close();

    const member = async () => accountFor(PRICE_WATCH_WORKSPACE_ID, "user-2", "member@example.com");
    const patch = await patchPriceWatcher(
      new Request(`https://signal.example/api/price-watch/${watcherId}`, { method: "PATCH", headers: { origin: "https://signal.example", "content-type": "application/json" }, body: JSON.stringify({ cadence: "hourly" }) }),
      { params: { watcherId } },
      services(item.openDatabase, member),
    );
    assert.equal(patch.status, 200);
    assert.equal((await patch.json()).watcher.cadence, "hourly");

    const outsider = async () => accountFor("workspace-other", "user-other", "other@example.com");
    const deniedHistory = await getPriceWatchHistory(new Request(`https://signal.example/api/price-watch/${watcherId}`), { params: { watcherId } }, services(item.openDatabase, outsider));
    assert.equal(deniedHistory.status, 404);
    const deniedPatch = await patchPriceWatcher(
      new Request(`https://signal.example/api/price-watch/${watcherId}`, { method: "PATCH", headers: { origin: "https://signal.example", "content-type": "application/json" }, body: JSON.stringify({ cadence: "daily" }) }),
      { params: { watcherId } },
      services(item.openDatabase, outsider),
    );
    assert.equal(deniedPatch.status, 404);

    const notifications = await getPriceWatchNotifications(new Request("https://signal.example/api/price-watch/notifications"), services(item.openDatabase, member));
    assert.equal(notifications.status, 200);
    assert.equal((await notifications.json()).unread, 1);
    const read = await markPriceWatchNotificationsRead(
      new Request("https://signal.example/api/price-watch/notifications", { method: "POST", headers: { origin: "https://signal.example", "content-type": "application/json" }, body: JSON.stringify({ notificationIds: ["notification-1"] }) }),
      services(item.openDatabase, member),
    );
    assert.equal(read.status, 200);
    assert.equal((await read.json()).marked, 1);

    const removed = await removePriceWatcher(
      new Request(`https://signal.example/api/price-watch/${watcherId}`, { method: "DELETE", headers: { origin: "https://signal.example" } }),
      { params: { watcherId } },
      services(item.openDatabase, member),
    );
    assert.equal(removed.status, 200);
    assert.equal((await removed.json()).deleted, true);
  } finally { rmSync(item.directory, { recursive: true, force: true }); }
});
