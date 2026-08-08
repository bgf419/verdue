export type PersonalClaimStatus =
  | "tracking"
  | "started"
  | "submitted"
  | "confirmation_recorded"
  | "under_review"
  | "approved"
  | "denied"
  | "payment_pending"
  | "paid"
  | "closed"
  | "withdrawn"
  | "unknown";

export type StatusProvenance =
  | "user_reported"
  | "confirmation_email"
  | "official_claim_portal"
  | "settlement_administrator_notice"
  | "court_document"
  | "government_agency_notice"
  | "system_import"
  | "unknown";

export type AmountSource =
  | "user_reported"
  | "official_claim_portal"
  | "settlement_administrator_notice"
  | "payment_record"
  | "government_agency_notice"
  | "system_import"
  | "unknown";

export type ClaimEventType =
  | "claim_created"
  | "status_updated"
  | "submission_recorded"
  | "confirmation_recorded"
  | "approval_recorded"
  | "denial_recorded"
  | "payment_recorded"
  | "note_added";

export type AutofillProfile = {
  fullName: string;
  email: string;
  phone: string;
  address: string;
  addressLine2: string;
  city: string;
  state: string;
  zip: string;
  countryCode: string;
  createdAt: string;
  updatedAt: string;
};

export type AutofillProfileInput = Omit<AutofillProfile, "createdAt" | "updatedAt">;

export type SavedCase = {
  id: string;
  caseId: string;
  caseTitle: string | null;
  sourceUrl: string | null;
  createdAt: string;
  updatedAt: string;
};

export type UserClaim = {
  id: string;
  caseId: string;
  caseTitle: string | null;
  company: string | null;
  personalStatus: PersonalClaimStatus;
  statusProvenance: StatusProvenance;
  confirmationNumber: string | null;
  submittedAt: string | null;
  approvedAt: string | null;
  approvedAmountCents: number | null;
  paidAt: string | null;
  receivedAmountCents: number | null;
  amountSource: AmountSource | null;
  privateNote: string | null;
  createdAt: string;
  updatedAt: string;
};

export type UserClaimOutcomeInput = {
  personalStatus: PersonalClaimStatus;
  confirmationNumber: string | null;
  submittedAt: string | null;
  approvedAmountCents: number | null;
  receivedAmountCents: number | null;
  amountSource: AmountSource | null;
  provenance?: StatusProvenance;
};

export type ClaimEvent = {
  id: string;
  claimId: string;
  eventType: ClaimEventType;
  personalStatus: PersonalClaimStatus | null;
  provenance: StatusProvenance;
  confirmationNumber: string | null;
  amountCents: number | null;
  amountKind: "approved" | "received" | null;
  note: string | null;
  metadata: Record<string, unknown>;
  occurredAt: string;
  createdAt: string;
};

export type SupabaseErrorLike = {
  message: string;
  code?: string;
  details?: string;
  hint?: string;
};

export type SupabaseResultLike = {
  data: unknown;
  error: SupabaseErrorLike | null;
};

type SupabasePrivateTable =
  | "profiles"
  | "saved_cases"
  | "user_claims"
  | "user_claim_events";

interface SupabaseQueryLike extends PromiseLike<SupabaseResultLike> {
  select(columns?: string): SupabaseQueryLike;
  eq(column: string, value: unknown): SupabaseQueryLike;
  order(
    column: string,
    options?: { ascending?: boolean; nullsFirst?: boolean },
  ): SupabaseQueryLike;
  limit(count: number): SupabaseQueryLike;
  single(): PromiseLike<SupabaseResultLike>;
  maybeSingle(): PromiseLike<SupabaseResultLike>;
}

interface SupabaseTableLike {
  select(columns?: string): SupabaseQueryLike;
  insert(values: unknown, options?: Record<string, unknown>): SupabaseQueryLike;
  upsert(values: unknown, options?: Record<string, unknown>): SupabaseQueryLike;
  update(values: unknown): SupabaseQueryLike;
  delete(): SupabaseQueryLike;
}

export interface SupabaseClientLike {
  from(table: SupabasePrivateTable): unknown;
  rpc(functionName: "delete_my_account"): unknown;
}

export class SupabaseDataError extends Error {
  readonly operation: string;
  readonly code?: string;
  readonly details?: string;
  readonly hint?: string;

  constructor(operation: string, error: SupabaseErrorLike) {
    super(`${operation}: ${error.message}`);
    this.name = "SupabaseDataError";
    this.operation = operation;
    this.code = error.code;
    this.details = error.details;
    this.hint = error.hint;
  }
}

type ProfileRow = {
  full_name: string;
  contact_email: string;
  phone: string;
  address_line1: string;
  address_line2: string;
  city: string;
  region: string;
  postal_code: string;
  country_code: string;
  created_at: string;
  updated_at: string;
};

type SavedCaseRow = {
  id: string;
  case_id: string;
  case_title_snapshot: string | null;
  source_url_snapshot: string | null;
  created_at: string;
  updated_at: string;
};

type UserClaimRow = {
  id: string;
  case_id: string;
  case_title_snapshot: string | null;
  company_snapshot: string | null;
  personal_status: PersonalClaimStatus;
  status_provenance: StatusProvenance;
  confirmation_number: string | null;
  submitted_at: string | null;
  approved_at: string | null;
  approved_amount_cents: number | null;
  paid_at: string | null;
  received_amount_cents: number | null;
  amount_source: AmountSource | null;
  private_note: string | null;
  created_at: string;
  updated_at: string;
};

type ClaimEventRow = {
  id: string;
  user_claim_id: string;
  event_type: ClaimEventType;
  personal_status: PersonalClaimStatus | null;
  provenance: StatusProvenance;
  confirmation_number: string | null;
  amount_cents: number | null;
  amount_kind: "approved" | "received" | null;
  note: string | null;
  metadata: Record<string, unknown>;
  occurred_at: string;
  created_at: string;
};

const PROFILE_COLUMNS =
  "full_name, contact_email, phone, address_line1, address_line2, city, region, postal_code, country_code, created_at, updated_at";
const SAVED_CASE_COLUMNS =
  "id, case_id, case_title_snapshot, source_url_snapshot, created_at, updated_at";
const USER_CLAIM_COLUMNS =
  "id, case_id, case_title_snapshot, company_snapshot, personal_status, status_provenance, confirmation_number, submitted_at, approved_at, approved_amount_cents, paid_at, received_amount_cents, amount_source, private_note, created_at, updated_at";
const CLAIM_EVENT_COLUMNS =
  "id, user_claim_id, event_type, personal_status, provenance, confirmation_number, amount_cents, amount_kind, note, metadata, occurred_at, created_at";

function requireNonempty(value: string, field: string, maximum: number): string {
  const normalized = value.trim();
  if (!normalized) throw new TypeError(`${field} is required`);
  if (normalized.length > maximum) {
    throw new TypeError(`${field} must be ${maximum} characters or fewer`);
  }
  return normalized;
}

function requireUuid(value: string): string {
  const normalized = value.trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(normalized)) {
    throw new TypeError("userId must be a UUID");
  }
  return normalized;
}

function isoNow(): string {
  return new Date().toISOString();
}

async function readResult<T>(
  operation: string,
  request: PromiseLike<SupabaseResultLike>,
): Promise<T> {
  const result = await request;
  if (result.error) throw new SupabaseDataError(operation, result.error);
  return result.data as T;
}

function mapProfile(row: ProfileRow): AutofillProfile {
  return {
    fullName: row.full_name,
    email: row.contact_email,
    phone: row.phone,
    address: row.address_line1,
    addressLine2: row.address_line2,
    city: row.city,
    state: row.region,
    zip: row.postal_code,
    countryCode: row.country_code,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapSavedCase(row: SavedCaseRow): SavedCase {
  return {
    id: row.id,
    caseId: row.case_id,
    caseTitle: row.case_title_snapshot,
    sourceUrl: row.source_url_snapshot,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapUserClaim(row: UserClaimRow): UserClaim {
  return {
    id: row.id,
    caseId: row.case_id,
    caseTitle: row.case_title_snapshot,
    company: row.company_snapshot,
    personalStatus: row.personal_status,
    statusProvenance: row.status_provenance,
    confirmationNumber: row.confirmation_number,
    submittedAt: row.submitted_at,
    approvedAt: row.approved_at,
    approvedAmountCents: row.approved_amount_cents,
    paidAt: row.paid_at,
    receivedAmountCents: row.received_amount_cents,
    amountSource: row.amount_source,
    privateNote: row.private_note,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapClaimEvent(row: ClaimEventRow): ClaimEvent {
  return {
    id: row.id,
    claimId: row.user_claim_id,
    eventType: row.event_type,
    personalStatus: row.personal_status,
    provenance: row.provenance,
    confirmationNumber: row.confirmation_number,
    amountCents: row.amount_cents,
    amountKind: row.amount_kind,
    note: row.note,
    metadata: row.metadata,
    occurredAt: row.occurred_at,
    createdAt: row.created_at,
  };
}

export class SupabaseDataStore {
  readonly userId: string;

  constructor(
    private readonly client: SupabaseClientLike,
    userId: string,
  ) {
    this.userId = requireUuid(userId);
  }

  async getProfile(): Promise<AutofillProfile | null> {
    const row = await readResult<ProfileRow | null>(
      "Load profile",
      this.table("profiles")
        .select(PROFILE_COLUMNS)
        .eq("id", this.userId)
        .maybeSingle(),
    );
    return row ? mapProfile(row) : null;
  }

  async saveProfile(input: AutofillProfileInput): Promise<AutofillProfile> {
    const countryCode = input.countryCode.trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(countryCode)) {
      throw new TypeError("countryCode must be a two-letter ISO code");
    }

    const row = await readResult<ProfileRow>(
      "Save profile",
      this.table("profiles")
        .upsert(
          {
            id: this.userId,
            full_name: input.fullName.trim(),
            contact_email: input.email.trim(),
            phone: input.phone.trim(),
            address_line1: input.address.trim(),
            address_line2: input.addressLine2.trim(),
            city: input.city.trim(),
            region: input.state.trim(),
            postal_code: input.zip.trim(),
            country_code: countryCode,
          },
          { onConflict: "id" },
        )
        .select(PROFILE_COLUMNS)
        .single(),
    );
    return mapProfile(row);
  }

  async listSavedCases(): Promise<SavedCase[]> {
    const rows = await readResult<SavedCaseRow[]>(
      "Load saved cases",
      this.table("saved_cases")
        .select(SAVED_CASE_COLUMNS)
        .eq("user_id", this.userId)
        .order("created_at", { ascending: false }),
    );
    return rows.map(mapSavedCase);
  }

  async saveCase(input: {
    caseId: string;
    caseTitle?: string | null;
    sourceUrl?: string | null;
  }): Promise<SavedCase> {
    const row = await readResult<SavedCaseRow>(
      "Save case",
      this.table("saved_cases")
        .upsert(
          {
            user_id: this.userId,
            case_id: requireNonempty(input.caseId, "caseId", 256),
            case_title_snapshot: input.caseTitle?.trim() || null,
            source_url_snapshot: input.sourceUrl?.trim() || null,
          },
          { onConflict: "user_id,case_id" },
        )
        .select(SAVED_CASE_COLUMNS)
        .single(),
    );
    return mapSavedCase(row);
  }

  async unsaveCase(caseId: string): Promise<void> {
    await readResult<unknown>(
      "Remove saved case",
      this.table("saved_cases")
        .delete()
        .eq("user_id", this.userId)
        .eq("case_id", requireNonempty(caseId, "caseId", 256)),
    );
  }

  async listClaims(): Promise<UserClaim[]> {
    const rows = await readResult<UserClaimRow[]>(
      "Load application history",
      this.table("user_claims")
        .select(USER_CLAIM_COLUMNS)
        .eq("user_id", this.userId)
        .order("updated_at", { ascending: false }),
    );
    return rows.map(mapUserClaim);
  }

  async getClaim(claimId: string): Promise<UserClaim | null> {
    const row = await readResult<UserClaimRow | null>(
      "Load application",
      this.table("user_claims")
        .select(USER_CLAIM_COLUMNS)
        .eq("id", requireUuid(claimId))
        .eq("user_id", this.userId)
        .maybeSingle(),
    );
    return row ? mapUserClaim(row) : null;
  }

  async startClaim(input: {
    caseId: string;
    caseTitle?: string | null;
    company?: string | null;
    privateNote?: string | null;
  }): Promise<UserClaim> {
    const caseId = requireNonempty(input.caseId, "caseId", 256);
    const inserted = await readResult<UserClaimRow | null>(
      "Start application",
      this.table("user_claims")
        .upsert(
          {
            user_id: this.userId,
            case_id: caseId,
            case_title_snapshot: input.caseTitle?.trim() || null,
            company_snapshot: input.company?.trim() || null,
            personal_status: "started",
            status_provenance: "user_reported",
            private_note: input.privateNote?.trim() || null,
          },
          {
            onConflict: "user_id,case_id",
            ignoreDuplicates: true,
          },
        )
        .select(USER_CLAIM_COLUMNS)
        .maybeSingle(),
    );
    if (inserted) return mapUserClaim(inserted);

    const existing = await readResult<UserClaimRow | null>(
      "Load existing application",
      this.table("user_claims")
        .select(USER_CLAIM_COLUMNS)
        .eq("user_id", this.userId)
        .eq("case_id", caseId)
        .maybeSingle(),
    );
    if (!existing) {
      throw new Error("Application could not be started or loaded");
    }
    return mapUserClaim(existing);
  }

  async saveClaimOutcome(
    claimId: string,
    input: UserClaimOutcomeInput,
  ): Promise<UserClaim> {
    validateCents(input.approvedAmountCents, "approvedAmountCents");
    validateCents(input.receivedAmountCents, "receivedAmountCents");

    const existing = await this.getClaim(claimId);
    if (!existing) throw new Error("Application history was not found");

    const now = isoNow();
    const confirmationNumber = input.confirmationNumber?.trim() || null;
    const amountSource =
      input.approvedAmountCents !== null || input.receivedAmountCents !== null
        ? input.amountSource
        : null;

    return this.updateClaim(
      claimId,
      {
        personal_status: input.personalStatus,
        status_provenance: input.provenance ?? "user_reported",
        confirmation_number: confirmationNumber,
        submitted_at: input.submittedAt,
        approved_at:
          existing.approvedAt ?? (input.personalStatus === "approved" ? now : null),
        approved_amount_cents: input.approvedAmountCents,
        paid_at: existing.paidAt ?? (input.personalStatus === "paid" ? now : null),
        received_amount_cents: input.receivedAmountCents,
        amount_source: amountSource,
      },
      "Save application outcome",
    );
  }

  async updateClaimStatus(
    claimId: string,
    status: PersonalClaimStatus,
    provenance: StatusProvenance = "user_reported",
  ): Promise<UserClaim> {
    return this.updateClaim(
      claimId,
      { personal_status: status, status_provenance: provenance },
      "Update application status",
    );
  }

  async recordSubmission(
    claimId: string,
    input: {
      submittedAt?: string;
      confirmationNumber?: string | null;
      provenance?: StatusProvenance;
    } = {},
  ): Promise<UserClaim> {
    const confirmationNumber = input.confirmationNumber?.trim() || null;
    return this.updateClaim(
      claimId,
      {
        personal_status: confirmationNumber ? "confirmation_recorded" : "submitted",
        status_provenance: input.provenance ?? "user_reported",
        confirmation_number: confirmationNumber,
        submitted_at: input.submittedAt ?? isoNow(),
      },
      "Record submission",
    );
  }

  async recordConfirmation(
    claimId: string,
    confirmationNumber: string,
    provenance: StatusProvenance = "confirmation_email",
  ): Promise<UserClaim> {
    return this.updateClaim(
      claimId,
      {
        personal_status: "confirmation_recorded",
        status_provenance: provenance,
        confirmation_number: requireNonempty(
          confirmationNumber,
          "confirmationNumber",
          250,
        ),
      },
      "Record confirmation",
    );
  }

  async recordApproval(
    claimId: string,
    input: {
      approvedAmountCents?: number | null;
      approvedAt?: string;
      provenance?: StatusProvenance;
      amountSource?: AmountSource | null;
    } = {},
  ): Promise<UserClaim> {
    validateCents(input.approvedAmountCents, "approvedAmountCents");
    return this.updateClaim(
      claimId,
      {
        personal_status: "approved",
        status_provenance: input.provenance ?? "user_reported",
        approved_at: input.approvedAt ?? isoNow(),
        approved_amount_cents: input.approvedAmountCents ?? null,
        amount_source: input.amountSource ?? null,
      },
      "Record approval",
    );
  }

  async recordDenial(
    claimId: string,
    provenance: StatusProvenance = "user_reported",
  ): Promise<UserClaim> {
    return this.updateClaim(
      claimId,
      { personal_status: "denied", status_provenance: provenance },
      "Record denial",
    );
  }

  async recordPayment(
    claimId: string,
    input: {
      receivedAmountCents?: number | null;
      paidAt?: string;
      provenance?: StatusProvenance;
      amountSource?: AmountSource | null;
    } = {},
  ): Promise<UserClaim> {
    validateCents(input.receivedAmountCents, "receivedAmountCents");
    return this.updateClaim(
      claimId,
      {
        personal_status: "paid",
        status_provenance: input.provenance ?? "user_reported",
        paid_at: input.paidAt ?? isoNow(),
        received_amount_cents: input.receivedAmountCents ?? null,
        amount_source: input.amountSource ?? null,
      },
      "Record payment",
    );
  }

  async setPrivateNote(claimId: string, note: string | null): Promise<UserClaim> {
    return this.updateClaim(
      claimId,
      { private_note: note?.trim() || null },
      "Update private note",
    );
  }

  async addClaimNote(
    claimId: string,
    note: string,
    occurredAt = isoNow(),
  ): Promise<ClaimEvent> {
    const row = await readResult<ClaimEventRow>(
      "Add application activity note",
      this.table("user_claim_events")
        .insert({
          user_id: this.userId,
          user_claim_id: requireUuid(claimId),
          event_type: "note_added",
          provenance: "user_reported",
          note: requireNonempty(note, "note", 5000),
          occurred_at: occurredAt,
        })
        .select(CLAIM_EVENT_COLUMNS)
        .single(),
    );
    return mapClaimEvent(row);
  }

  async listClaimEvents(claimId: string, limit = 200): Promise<ClaimEvent[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      throw new TypeError("limit must be an integer from 1 through 500");
    }
    const rows = await readResult<ClaimEventRow[]>(
      "Load application activity",
      this.table("user_claim_events")
        .select(CLAIM_EVENT_COLUMNS)
        .eq("user_id", this.userId)
        .eq("user_claim_id", requireUuid(claimId))
        .order("occurred_at", { ascending: false })
        .limit(limit),
    );
    return rows.map(mapClaimEvent);
  }

  async deleteClaim(claimId: string): Promise<void> {
    await readResult<unknown>(
      "Delete application history",
      this.table("user_claims")
        .delete()
        .eq("id", requireUuid(claimId))
        .eq("user_id", this.userId),
    );
  }

  async deleteAccount(): Promise<void> {
    await readResult<unknown>(
      "Delete account",
      this.rpcDeleteAccount(),
    );
  }

  private async updateClaim(
    claimId: string,
    patch: Record<string, unknown>,
    operation: string,
  ): Promise<UserClaim> {
    const row = await readResult<UserClaimRow>(
      operation,
      this.table("user_claims")
        .update(patch)
        .eq("id", requireUuid(claimId))
        .eq("user_id", this.userId)
        .select(USER_CLAIM_COLUMNS)
        .single(),
    );
    return mapUserClaim(row);
  }

  private table(name: SupabasePrivateTable): SupabaseTableLike {
    return this.client.from(name) as SupabaseTableLike;
  }

  private rpcDeleteAccount(): PromiseLike<SupabaseResultLike> {
    return this.client.rpc("delete_my_account") as PromiseLike<SupabaseResultLike>;
  }
}

function validateCents(value: number | null | undefined, field: string): void {
  if (value == null) return;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${field} must be a nonnegative integer`);
  }
}

export function createSupabaseDataStore(
  client: SupabaseClientLike,
  authenticatedUserId: string,
): SupabaseDataStore {
  return new SupabaseDataStore(client, authenticatedUserId);
}
