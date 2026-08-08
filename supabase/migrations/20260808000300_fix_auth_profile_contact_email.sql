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
    case
      when pg_catalog.lower(coalesce(new.email, '')) like '%@accounts.verdue.invalid' then ''
      else coalesce(new.email, '')
    end
  )
  on conflict (id) do nothing;

  return new;
end;
$function$;

comment on function public.handle_verdue_auth_user_created() is
  'Creates a private profile without copying the synthetic Account ID email into claimant contact data.';
