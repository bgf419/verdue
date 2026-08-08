begin;

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null default '',
  contact_email text not null default '',
  phone text not null default '',
  address_line1 text not null default '',
  address_line2 text not null default '',
  city text not null default '',
  region text not null default '',
  postal_code text not null default '',
  country_code text not null default 'US',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint profiles_full_name_length check (char_length(full_name) <= 300),
  constraint profiles_contact_email_length check (char_length(contact_email) <= 320),
  constraint profiles_phone_length check (char_length(phone) <= 80),
  constraint profiles_address_line1_length check (char_length(address_line1) <= 500),
  constraint profiles_address_line2_length check (char_length(address_line2) <= 500),
  constraint profiles_city_length check (char_length(city) <= 200),
  constraint profiles_region_length check (char_length(region) <= 200),
  constraint profiles_postal_code_length check (char_length(postal_code) <= 40),
  constraint profiles_country_code_format check (country_code ~ '^[A-Z]{2}$')
);

comment on table public.profiles is
  'Private, user-maintained contact details used to prefill external claim forms.';
comment on column public.profiles.contact_email is
  'A claim-form contact address. It is not evidence that the auth email is verified.';

create table public.saved_cases (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  case_id text not null,
  case_title_snapshot text,
  source_url_snapshot text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint saved_cases_user_case_key unique (user_id, case_id),
  constraint saved_cases_case_id_length check (
    char_length(case_id) between 1 and 256
  ),
  constraint saved_cases_title_length check (
    case_title_snapshot is null or char_length(case_title_snapshot) <= 500
  ),
  constraint saved_cases_source_url_length check (
    source_url_snapshot is null or char_length(source_url_snapshot) <= 2048
  )
);

comment on table public.saved_cases is
  'Private bookmarks keyed to the public catalog case identifier.';

create table public.user_claims (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  case_id text not null,
  case_title_snapshot text,
  company_snapshot text,
  personal_status text not null default 'tracking',
  status_provenance text not null default 'user_reported',
  confirmation_number text,
  submitted_at timestamptz,
  approved_at timestamptz,
  approved_amount_cents bigint,
  paid_at timestamptz,
  received_amount_cents bigint,
  amount_source text,
  private_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint user_claims_user_case_key unique (user_id, case_id),
  constraint user_claims_id_user_id_key unique (id, user_id),
  constraint user_claims_case_id_length check (
    char_length(case_id) between 1 and 256
  ),
  constraint user_claims_title_length check (
    case_title_snapshot is null or char_length(case_title_snapshot) <= 500
  ),
  constraint user_claims_company_length check (
    company_snapshot is null or char_length(company_snapshot) <= 300
  ),
  constraint user_claims_confirmation_length check (
    confirmation_number is null or char_length(confirmation_number) <= 250
  ),
  constraint user_claims_note_length check (
    private_note is null or char_length(private_note) <= 5000
  ),
  constraint user_claims_personal_status_check check (
    personal_status in (
      'tracking',
      'started',
      'submitted',
      'confirmation_recorded',
      'under_review',
      'approved',
      'denied',
      'payment_pending',
      'paid',
      'closed',
      'withdrawn',
      'unknown'
    )
  ),
  constraint user_claims_status_provenance_check check (
    status_provenance in (
      'user_reported',
      'confirmation_email',
      'official_claim_portal',
      'settlement_administrator_notice',
      'court_document',
      'government_agency_notice',
      'system_import',
      'unknown'
    )
  ),
  constraint user_claims_amount_source_check check (
    amount_source is null or amount_source in (
      'user_reported',
      'official_claim_portal',
      'settlement_administrator_notice',
      'payment_record',
      'government_agency_notice',
      'system_import',
      'unknown'
    )
  ),
  constraint user_claims_approved_amount_nonnegative check (
    approved_amount_cents is null or approved_amount_cents >= 0
  ),
  constraint user_claims_received_amount_nonnegative check (
    received_amount_cents is null or received_amount_cents >= 0
  ),
  constraint user_claims_paid_status_has_date check (
    personal_status <> 'paid' or paid_at is not null
  ),
  constraint user_claims_paid_after_submission check (
    paid_at is null or submitted_at is null or paid_at >= submitted_at
  )
);

comment on table public.user_claims is
  'Private application history. Status fields represent the account holder''s record, not an authoritative court or administrator status.';

create table public.user_claim_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  user_claim_id uuid not null,
  event_type text not null,
  personal_status text,
  provenance text not null default 'user_reported',
  confirmation_number text,
  amount_cents bigint,
  amount_kind text,
  note text,
  metadata jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  constraint user_claim_events_claim_owner_fk
    foreign key (user_claim_id, user_id)
    references public.user_claims(id, user_id)
    on delete cascade,
  constraint user_claim_events_type_check check (
    event_type in (
      'claim_created',
      'status_updated',
      'submission_recorded',
      'confirmation_recorded',
      'approval_recorded',
      'denial_recorded',
      'payment_recorded',
      'note_added'
    )
  ),
  constraint user_claim_events_status_check check (
    personal_status is null or personal_status in (
      'tracking',
      'started',
      'submitted',
      'confirmation_recorded',
      'under_review',
      'approved',
      'denied',
      'payment_pending',
      'paid',
      'closed',
      'withdrawn',
      'unknown'
    )
  ),
  constraint user_claim_events_provenance_check check (
    provenance in (
      'user_reported',
      'confirmation_email',
      'official_claim_portal',
      'settlement_administrator_notice',
      'court_document',
      'government_agency_notice',
      'system_import',
      'unknown'
    )
  ),
  constraint user_claim_events_confirmation_length check (
    confirmation_number is null or char_length(confirmation_number) <= 250
  ),
  constraint user_claim_events_amount_nonnegative check (
    amount_cents is null or amount_cents >= 0
  ),
  constraint user_claim_events_amount_kind_check check (
    (amount_cents is null and amount_kind is null)
    or (amount_cents is not null and amount_kind in ('approved', 'received'))
  ),
  constraint user_claim_events_note_length check (
    note is null or char_length(note) <= 5000
  ),
  constraint user_claim_events_metadata_object check (
    jsonb_typeof(metadata) = 'object'
  )
);

comment on table public.user_claim_events is
  'Append-only activity for a user claim. Legal case milestones belong in the public catalog, not here.';

create index saved_cases_user_created_idx
  on public.saved_cases (user_id, created_at desc);
create index saved_cases_case_id_idx
  on public.saved_cases (case_id);
create index user_claims_user_updated_idx
  on public.user_claims (user_id, updated_at desc);
create index user_claims_user_status_idx
  on public.user_claims (user_id, personal_status);
create index user_claims_case_id_idx
  on public.user_claims (case_id);
create index user_claim_events_claim_occurred_idx
  on public.user_claim_events (user_claim_id, occurred_at desc);
create index user_claim_events_user_occurred_idx
  on public.user_claim_events (user_id, occurred_at desc);

create or replace function public.set_row_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  new.updated_at = pg_catalog.statement_timestamp();
  return new;
end;
$function$;

create trigger profiles_set_updated_at
before update on public.profiles
for each row execute function public.set_row_updated_at();

create trigger saved_cases_set_updated_at
before update on public.saved_cases
for each row execute function public.set_row_updated_at();

create trigger user_claims_set_updated_at
before update on public.user_claims
for each row execute function public.set_row_updated_at();

create or replace function public.log_user_claim_activity()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  activity_type text;
  activity_amount bigint;
  activity_amount_kind text;
  activity_at timestamptz := pg_catalog.statement_timestamp();
begin
  if tg_op = 'INSERT' then
    activity_type := 'claim_created';
  elsif old.paid_at is distinct from new.paid_at
    or old.received_amount_cents is distinct from new.received_amount_cents then
    activity_type := 'payment_recorded';
    activity_amount := new.received_amount_cents;
    activity_amount_kind := case
      when new.received_amount_cents is null then null
      else 'received'
    end;
    activity_at := coalesce(new.paid_at, activity_at);
  elsif old.approved_at is distinct from new.approved_at
    or old.approved_amount_cents is distinct from new.approved_amount_cents then
    activity_type := 'approval_recorded';
    activity_amount := new.approved_amount_cents;
    activity_amount_kind := case
      when new.approved_amount_cents is null then null
      else 'approved'
    end;
    activity_at := coalesce(new.approved_at, activity_at);
  elsif old.submitted_at is distinct from new.submitted_at then
    activity_type := 'submission_recorded';
    activity_at := coalesce(new.submitted_at, activity_at);
  elsif old.confirmation_number is distinct from new.confirmation_number then
    activity_type := 'confirmation_recorded';
  elsif new.personal_status = 'denied'
    and old.personal_status is distinct from new.personal_status then
    activity_type := 'denial_recorded';
  elsif old.personal_status is distinct from new.personal_status
    or old.status_provenance is distinct from new.status_provenance then
    activity_type := 'status_updated';
  else
    return new;
  end if;

  insert into public.user_claim_events (
    user_id,
    user_claim_id,
    event_type,
    personal_status,
    provenance,
    confirmation_number,
    amount_cents,
    amount_kind,
    occurred_at
  ) values (
    new.user_id,
    new.id,
    activity_type,
    new.personal_status,
    new.status_provenance,
    new.confirmation_number,
    activity_amount,
    activity_amount_kind,
    activity_at
  );

  return new;
end;
$function$;

create trigger user_claims_log_activity_insert
after insert on public.user_claims
for each row execute function public.log_user_claim_activity();

create trigger user_claims_log_activity_update
after update of
  personal_status,
  status_provenance,
  confirmation_number,
  submitted_at,
  approved_at,
  approved_amount_cents,
  paid_at,
  received_amount_cents,
  amount_source
on public.user_claims
for each row execute function public.log_user_claim_activity();

create or replace function public.handle_verdue_auth_user_created()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  insert into public.profiles (id, full_name, contact_email)
  values (
    new.id,
    coalesce(
      nullif(pg_catalog.btrim(new.raw_user_meta_data ->> 'full_name'), ''),
      nullif(pg_catalog.btrim(new.raw_user_meta_data ->> 'name'), ''),
      ''
    ),
    coalesce(new.email, '')
  )
  on conflict (id) do nothing;

  return new;
end;
$function$;

create trigger on_auth_user_created_verdue
after insert on auth.users
for each row execute function public.handle_verdue_auth_user_created();

alter table public.profiles enable row level security;
alter table public.saved_cases enable row level security;
alter table public.user_claims enable row level security;
alter table public.user_claim_events enable row level security;

create policy profiles_select_own
on public.profiles
for select
to authenticated
using ((select auth.uid()) = id);

create policy profiles_insert_own
on public.profiles
for insert
to authenticated
with check ((select auth.uid()) = id);

create policy profiles_update_own
on public.profiles
for update
to authenticated
using ((select auth.uid()) = id)
with check ((select auth.uid()) = id);

create policy saved_cases_select_own
on public.saved_cases
for select
to authenticated
using ((select auth.uid()) = user_id);

create policy saved_cases_insert_own
on public.saved_cases
for insert
to authenticated
with check ((select auth.uid()) = user_id);

create policy saved_cases_update_own
on public.saved_cases
for update
to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

create policy saved_cases_delete_own
on public.saved_cases
for delete
to authenticated
using ((select auth.uid()) = user_id);

create policy user_claims_select_own
on public.user_claims
for select
to authenticated
using ((select auth.uid()) = user_id);

create policy user_claims_insert_own
on public.user_claims
for insert
to authenticated
with check ((select auth.uid()) = user_id);

create policy user_claims_update_own
on public.user_claims
for update
to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

create policy user_claims_delete_own
on public.user_claims
for delete
to authenticated
using ((select auth.uid()) = user_id);

create policy user_claim_events_select_own
on public.user_claim_events
for select
to authenticated
using ((select auth.uid()) = user_id);

create policy user_claim_events_insert_own
on public.user_claim_events
for insert
to authenticated
with check (
  (select auth.uid()) = user_id
  and exists (
    select 1
    from public.user_claims
    where public.user_claims.id = user_claim_id
      and public.user_claims.user_id = (select auth.uid())
  )
);

revoke all on table public.profiles from public, anon;
revoke all on table public.saved_cases from public, anon;
revoke all on table public.user_claims from public, anon;
revoke all on table public.user_claim_events from public, anon;

grant select, insert, update on table public.profiles to authenticated;
grant select, insert, update, delete on table public.saved_cases to authenticated;
grant select, insert, update, delete on table public.user_claims to authenticated;
grant select, insert on table public.user_claim_events to authenticated;

revoke all on function public.set_row_updated_at() from public;
revoke all on function public.log_user_claim_activity() from public;
revoke all on function public.handle_verdue_auth_user_created() from public;

create or replace function public.delete_my_account()
returns void
language plpgsql
security definer
set search_path = ''
as $function$
declare
  requesting_user_id uuid := auth.uid();
begin
  if requesting_user_id is null then
    raise exception 'Authentication is required to delete an account'
      using errcode = '42501';
  end if;

  delete from auth.users
  where auth.users.id = requesting_user_id;

  if not found then
    raise exception 'Authenticated account does not exist'
      using errcode = 'P0002';
  end if;
end;
$function$;

comment on function public.delete_my_account() is
  'Deletes only auth.uid(); product-owned profile, bookmark, claim, and activity rows cascade atomically.';

revoke all on function public.delete_my_account() from public, anon;
grant execute on function public.delete_my_account() to authenticated;

commit;
