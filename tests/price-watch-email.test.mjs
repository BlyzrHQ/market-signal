import assert from "node:assert/strict";
import test from "node:test";

import { flushPriceWatchEmailOutbox } from "../app/lib/price-watch-email.ts";
import {
  PRICE_WATCH_USER_ID,
  PRICE_WATCH_WORKSPACE_ID,
  openPriceWatchFixture,
} from "./helpers/price-watch-fixture.mjs";

function seedEmail(database, { index, createdAt, batchAfter, recipientUserId = PRICE_WATCH_USER_ID }) {
  const watcherId = `email-watcher-${index}`;
  const eventId = `email-event-${index}`;
  const outboxId = `email-outbox-${index}`;
  database.prepare(`INSERT INTO price_watchers (
    id, workspace_id, canonical_url, canonicalization_version, source_domain, rival_domain,
    product_name, variant_key, variant_json, audit_target, creator_user_id, email_owner_user_id,
    cadence, state, next_check_at, created_at, updated_at
  ) VALUES (?, ?, ?, 1, 'rival.example', 'rival.example', ?, 'default', '{}', ?, ?, ?, 'daily', 'active', ?, ?, ?)`)
    .run(watcherId, PRICE_WATCH_WORKSPACE_ID, `https://rival.example/products/${index}`, `Product ${index}`, `audit-email-${index}`, PRICE_WATCH_USER_ID, recipientUserId, createdAt, createdAt, createdAt);
  database.prepare(`INSERT INTO price_watch_events (id, watcher_id, event_type, detail_json, idempotency_key, observed_at) VALUES (?, ?, 'price-decreased', ?, ?, ?)`)
    .run(eventId, watcherId, JSON.stringify({ previous: { amountMicros: 12_000_000 }, current: { amountMicros: 10_000_000 } }), `email-event-${index}`, createdAt);
  database.prepare(`INSERT INTO price_watch_email_outbox (id, workspace_id, watcher_id, recipient_user_id, event_id, status, batch_after, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)`)
    .run(outboxId, PRICE_WATCH_WORKSPACE_ID, watcherId, recipientUserId, eventId, batchAfter, createdAt, createdAt);
  return { watcherId, eventId, outboxId };
}

test("a due email digest includes newer pending changes for the same recipient and is idempotent", async () => {
  const database = openPriceWatchFixture();
  try {
    seedEmail(database, { index: 1, createdAt: "2026-08-24T12:00:00.000Z", batchAfter: "2026-08-24T12:15:00.000Z" });
    seedEmail(database, { index: 2, createdAt: "2026-08-24T12:10:00.000Z", batchAfter: "2026-08-24T12:25:00.000Z" });
    const deliveries = [];
    const provider = { async send(input) { deliveries.push(input); } };
    const first = await flushPriceWatchEmailOutbox(database, { provider, now: new Date("2026-08-24T12:15:00.000Z") });
    assert.deepEqual(first, { configured: true, delivered: 2, pending: 0 });
    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0].to, "owner@example.com");
    assert.equal(deliveries[0].items.length, 2);
    assert.match(deliveries[0].subject, /^2 watched prices changed$/);
    assert.match(deliveries[0].idempotencyKey, /^[a-f0-9]{64}$/);

    const replay = await flushPriceWatchEmailOutbox(database, { provider, now: new Date("2026-08-24T12:30:00.000Z") });
    assert.deepEqual(replay, { configured: true, delivered: 0, pending: 0 });
    assert.equal(deliveries.length, 1);
  } finally { database.close(); }
});

test("missing or failing email delivery never loses the pending alert", async () => {
  const database = openPriceWatchFixture();
  try {
    seedEmail(database, { index: 1, createdAt: "2026-08-24T12:00:00.000Z", batchAfter: "2026-08-24T12:15:00.000Z" });
    assert.deepEqual(await flushPriceWatchEmailOutbox(database, { environment: {}, now: new Date("2026-08-24T12:15:00.000Z") }), { configured: false, delivered: 0, pending: 1 });
    const failed = await flushPriceWatchEmailOutbox(database, { provider: { async send() { throw new Error("provider unavailable / secret detail"); } }, now: new Date("2026-08-24T12:15:00.000Z") });
    assert.deepEqual(failed, { configured: true, delivered: 0, pending: 1 });
    const row = database.prepare(`SELECT status, attempt_count, last_error_code FROM price_watch_email_outbox`).get();
    assert.equal(row.status, "pending");
    assert.equal(row.attempt_count, 1);
    assert.doesNotMatch(row.last_error_code, /\s|\//);
  } finally { database.close(); }
});

test("the configured email webhook is HTTPS, authenticated, idempotent, and abortable", async () => {
  const database = openPriceWatchFixture();
  try {
    seedEmail(database, { index: 1, createdAt: "2026-08-24T12:00:00.000Z", batchAfter: "2026-08-24T12:15:00.000Z" });
    let request;
    const result = await flushPriceWatchEmailOutbox(database, {
      environment: { MARKET_SIGNAL_EMAIL_WEBHOOK_URL: "https://mail.example.test/price-watch", MARKET_SIGNAL_EMAIL_WEBHOOK_TOKEN: "t".repeat(32) },
      fetchImpl: async (url, init) => { request = { url: String(url), init }; return new Response(null, { status: 204 }); },
      now: new Date("2026-08-24T12:15:00.000Z"),
    });
    assert.equal(result.delivered, 1);
    assert.equal(request.url, "https://mail.example.test/price-watch");
    assert.match(request.init.headers.authorization, /^Bearer t{32}$/);
    assert.match(request.init.headers["idempotency-key"], /^[a-f0-9]{64}$/);
    assert.equal(request.init.signal instanceof AbortSignal, true);
    assert.equal(request.init.signal.aborted, false);
  } finally { database.close(); }
});

test("email ownership falls back to the current workspace owner when the creator leaves", async () => {
  const database = openPriceWatchFixture();
  try {
    const seeded = seedEmail(database, { index: 1, createdAt: "2026-08-24T12:00:00.000Z", batchAfter: "2026-08-24T12:15:00.000Z" });
    database.prepare(`INSERT INTO "user" (id, name, email) VALUES ('replacement-owner', 'Replacement', 'replacement@example.com')`).run();
    database.prepare(`INSERT INTO workspace_members (workspace_id, user_id, role, created_at) VALUES (?, 'replacement-owner', 'owner', '2026-08-24T12:01:00.000Z')`).run(PRICE_WATCH_WORKSPACE_ID);
    database.prepare(`DELETE FROM "user" WHERE id = ?`).run(PRICE_WATCH_USER_ID);
    const deliveries = [];
    const result = await flushPriceWatchEmailOutbox(database, {
      provider: { async send(input) { deliveries.push(input); } },
      now: new Date("2026-08-24T12:15:00.000Z"),
    });
    assert.equal(result.delivered, 1);
    assert.equal(deliveries[0].to, "replacement@example.com");
    assert.equal(database.prepare(`SELECT email_owner_user_id FROM price_watchers WHERE id = ?`).get(seeded.watcherId).email_owner_user_id, "replacement-owner");
  } finally { database.close(); }
});

test("a competing flusher cannot reclaim a live send", async () => {
  const database = openPriceWatchFixture();
  try {
    seedEmail(database, { index: 1, createdAt: "2026-08-24T12:00:00.000Z", batchAfter: "2026-08-24T12:15:00.000Z" });
    let release;
    const blocked = new Promise((resolve) => { release = resolve; });
    const first = flushPriceWatchEmailOutbox(database, {
      provider: { async send() { await blocked; } },
      now: new Date("2026-08-24T12:15:00.000Z"),
    });
    await Promise.resolve();
    assert.equal(database.prepare(`SELECT status FROM price_watch_email_outbox`).get().status, "sending");
    const competing = await flushPriceWatchEmailOutbox(database, {
      provider: { async send() { throw new Error("must not send"); } },
      now: new Date("2026-08-24T12:16:00.000Z"),
    });
    assert.deepEqual(competing, { configured: true, delivered: 0, pending: 1 });
    release();
    assert.deepEqual(await first, { configured: true, delivered: 1, pending: 0 });
  } finally { database.close(); }
});
