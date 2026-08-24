import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { ensurePriceWatchSchema } from "./price-watch-store.ts";

export type PriceWatchEmailItem = {
  productName: string;
  eventType: string;
  observedAt: string;
  detail: Record<string, unknown>;
};

export type PriceWatchEmailProvider = {
  send(input: { to: string; subject: string; items: PriceWatchEmailItem[]; idempotencyKey: string }): Promise<void>;
};

type EmailEnvironment = Record<string, string | undefined>;
const EMAIL_DELIVERY_TIMEOUT_MS = 10_000;

function providerFromEnvironment(environment: EmailEnvironment = process.env, fetchImpl: typeof fetch = fetch): PriceWatchEmailProvider | null {
  const endpoint = String(environment.MARKET_SIGNAL_EMAIL_WEBHOOK_URL || "").trim();
  const token = String(environment.MARKET_SIGNAL_EMAIL_WEBHOOK_TOKEN || "").trim();
  let url: URL;
  try { url = new URL(endpoint); } catch { return null; }
  if (url.protocol !== "https:" || url.username || url.password || token.length < 32 || /\s/.test(token)) return null;
  return {
    async send(input) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), EMAIL_DELIVERY_TIMEOUT_MS);
      try {
        const response = await fetchImpl(url, {
          method: "POST",
          signal: controller.signal,
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
            "idempotency-key": input.idempotencyKey,
          },
          body: JSON.stringify(input),
        });
        if (!response.ok) throw new Error(`email-provider-${response.status}`);
      } finally { clearTimeout(timeout); }
    },
  };
}

function parsedDetail(value: unknown) {
  try {
    const parsed = JSON.parse(String(value || "{}"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch { return {}; }
}

function recipient(database: Database.Database, row: Record<string, unknown>) {
  const workspaceId = String(row.workspace_id || "");
  const preferredId = String(row.recipient_user_id || "");
  const preferred = preferredId ? database.prepare(`SELECT users.id, users.email FROM "user" users JOIN workspace_members members ON members.user_id = users.id AND members.workspace_id = ? WHERE users.id = ? LIMIT 1`).get(workspaceId, preferredId) as { id?: string; email?: string } | undefined : undefined;
  if (preferred?.id && preferred.email) return { id: preferred.id, email: preferred.email };
  const owner = database.prepare(`SELECT users.id, users.email FROM workspace_members members JOIN "user" users ON users.id = members.user_id WHERE members.workspace_id = ? AND members.role = 'owner' ORDER BY members.created_at ASC, users.id ASC LIMIT 1`).get(workspaceId) as { id?: string; email?: string } | undefined;
  if (owner?.id && owner.email) {
    database.prepare(`UPDATE price_watchers SET email_owner_user_id = ?, updated_at = updated_at WHERE id = ? AND workspace_id = ?`).run(owner.id, row.watcher_id, workspaceId);
    return { id: owner.id, email: owner.email };
  }
  return null;
}

export async function flushPriceWatchEmailOutbox(
  database: Database.Database,
  options: { provider?: PriceWatchEmailProvider | null; environment?: EmailEnvironment; fetchImpl?: typeof fetch; now?: Date; limit?: number } = {},
) {
  ensurePriceWatchSchema(database);
  const provider = options.provider === undefined ? providerFromEnvironment(options.environment, options.fetchImpl) : options.provider;
  if (!provider) return { configured: false, delivered: 0, pending: Number((database.prepare(`SELECT COUNT(*) AS count FROM price_watch_email_outbox WHERE status <> 'delivered'`).get() as { count?: number }).count || 0) };
  const now = options.now || new Date();
  const nowIso = now.toISOString();
  const stale = new Date(now.getTime() - 10 * 60 * 1_000).toISOString();
  database.prepare(`UPDATE price_watch_email_outbox SET status = 'pending', last_error_code = 'stale-send-recovered', updated_at = ? WHERE status = 'sending' AND updated_at <= ?`).run(nowIso, stale);
  const bounded = Math.min(200, Math.max(1, Math.trunc(options.limit || 200)));
  // Read the oldest bounded pending window, then send a recipient group only
  // when at least one item in that group has completed its 15-minute wait. This
  // lets newer changes for the same recipient ride in the same digest instead
  // of producing a second email a few minutes later.
  const rows = database.prepare(`SELECT outbox.*, events.event_type, events.detail_json, events.observed_at, watchers.product_name FROM price_watch_email_outbox outbox JOIN price_watch_events events ON events.id = outbox.event_id JOIN price_watchers watchers ON watchers.id = outbox.watcher_id WHERE outbox.status = 'pending' ORDER BY outbox.created_at ASC, outbox.id ASC LIMIT ?`).all(bounded) as Record<string, unknown>[];
  const groups = new Map<string, { recipient: { id: string; email: string }; rows: Record<string, unknown>[]; due: boolean }>();
  for (const row of rows) {
    const resolved = recipient(database, row);
    if (!resolved) continue;
    const key = `${String(row.workspace_id)}\n${resolved.id}`;
    const group = groups.get(key);
    const due = String(row.batch_after || "") <= nowIso;
    if (group) {
      group.rows.push(row);
      group.due ||= due;
    } else groups.set(key, { recipient: resolved, rows: [row], due });
  }
  let delivered = 0;
  for (const group of groups.values()) {
    if (!group.due) continue;
    const ids = group.rows.map((row) => String(row.id || ""));
    const placeholders = ids.map(() => "?").join(",");
    const claimed = database.prepare(`UPDATE price_watch_email_outbox SET status = 'sending', attempt_count = attempt_count + 1, updated_at = ? WHERE id IN (${placeholders}) AND status = 'pending'`).run(nowIso, ...ids);
    if (claimed.changes !== ids.length) continue;
    const idempotencyKey = createHash("sha256").update(ids.sort().join("\n")).digest("hex");
    try {
      await provider.send({
        to: group.recipient.email,
        subject: group.rows.length === 1 ? "A watched price changed" : `${group.rows.length} watched prices changed`,
        items: group.rows.map((row) => ({
          productName: String(row.product_name || "Watched product"),
          eventType: String(row.event_type || "price-changed"),
          observedAt: String(row.observed_at || ""),
          detail: parsedDetail(row.detail_json),
        })),
        idempotencyKey,
      });
      database.prepare(`UPDATE price_watch_email_outbox SET status = 'delivered', delivered_at = ?, last_error_code = '', updated_at = ? WHERE id IN (${placeholders}) AND status = 'sending'`).run(nowIso, nowIso, ...ids);
      delivered += ids.length;
    } catch (error) {
      const code = error instanceof Error ? error.message.replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 100) : "email-send-failed";
      database.prepare(`UPDATE price_watch_email_outbox SET status = 'pending', last_error_code = ?, updated_at = ? WHERE id IN (${placeholders}) AND status = 'sending'`).run(code, nowIso, ...ids);
    }
  }
  const pending = Number((database.prepare(`SELECT COUNT(*) AS count FROM price_watch_email_outbox WHERE status <> 'delivered'`).get() as { count?: number }).count || 0);
  return { configured: true, delivered, pending };
}
