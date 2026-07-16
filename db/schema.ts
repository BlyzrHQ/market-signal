import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const verifiedCompetitors = sqliteTable("verified_competitors", {
  primaryDomain: text("primary_domain").notNull(),
  competitorDomain: text("competitor_domain").notNull(),
  candidateJson: text("candidate_json").notNull(),
  firstVerifiedAt: text("first_verified_at").notNull(),
  lastVerifiedAt: text("last_verified_at").notNull(),
  lastVerificationScore: integer("last_verification_score").notNull(),
  category: text("category").notNull().default(""),
  evidenceUrl: text("evidence_url").notNull().default(""),
}, (table) => [
  primaryKey({ columns: [table.primaryDomain, table.competitorDomain] }),
  index("verified_competitors_primary_recent_idx").on(table.primaryDomain, table.lastVerifiedAt),
]);
