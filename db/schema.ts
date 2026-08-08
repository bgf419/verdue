import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const caseRecords = sqliteTable(
  "case_records",
  {
    id: text("id").primaryKey(),
    title: text("title").notNull(),
    defendant: text("defendant").notNull(),
    actionType: text("action_type").notNull(),
    category: text("category").notNull(),
    jurisdiction: text("jurisdiction").notNull(),
    court: text("court"),
    docketNumber: text("docket_number"),
    filedAt: text("filed_at"),
    caseStage: text("case_stage").notNull(),
    claimWindow: text("claim_window").notNull(),
    claimDeadline: text("claim_deadline"),
    officialUrl: text("official_url").notNull(),
    claimUrl: text("claim_url"),
    sourceUpdatedAt: text("source_updated_at"),
    verifiedAt: text("verified_at").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    index("idx_case_records_window_deadline").on(table.claimWindow, table.claimDeadline),
    index("idx_case_records_stage_category").on(table.caseStage, table.category),
  ],
);

export const caseEvents = sqliteTable(
  "case_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    caseId: text("case_id").notNull(),
    eventType: text("event_type").notNull(),
    happenedAt: text("happened_at").notNull(),
    label: text("label").notNull(),
    sourceUrl: text("source_url").notNull(),
    verificationState: text("verification_state").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [index("idx_case_events_case_happened").on(table.caseId, table.happenedAt)],
);

export const profiles = sqliteTable("profiles", {
  userId: text("user_id").primaryKey(),
  email: text("email").notNull(),
  fullName: text("full_name").notNull(),
  phone: text("phone").notNull().default(""),
  address: text("address").notNull().default(""),
  city: text("city").notNull().default(""),
  state: text("state").notNull().default(""),
  zip: text("zip").notNull().default(""),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const userClaims = sqliteTable(
  "user_claims",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    caseId: text("case_id").notNull(),
    personalStatus: text("personal_status").notNull(),
    statusProvenance: text("status_provenance").notNull(),
    confirmationNumber: text("confirmation_number"),
    submittedAt: text("submitted_at"),
    approvedAmountCents: integer("approved_amount_cents"),
    receivedAmountCents: integer("received_amount_cents"),
    amountSource: text("amount_source"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    index("idx_user_claims_user_status").on(table.userId, table.personalStatus),
    uniqueIndex("idx_user_claims_user_case").on(table.userId, table.caseId),
  ],
);

export const userClaimEvents = sqliteTable(
  "user_claim_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userClaimId: text("user_claim_id").notNull(),
    userId: text("user_id").notNull(),
    eventType: text("event_type").notNull(),
    provenance: text("provenance").notNull(),
    happenedAt: text("happened_at").notNull(),
    note: text("note"),
  },
  (table) => [
    index("idx_user_claim_events_claim_happened").on(table.userClaimId, table.happenedAt),
    index("idx_user_claim_events_user").on(table.userId),
  ],
);
