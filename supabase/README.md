# Supabase: companies & profiles foundation

This document describes how to apply `migrations/001_companies_and_profiles.sql`
by hand, since the project does not use the Supabase CLI yet. Nothing in this
migration is executed automatically — you must run it yourself.

## What the migration creates

- `user_role` enum: `client`, `manager`, `accountant`, `warehouse`, `admin`.
- `public.companies` table (name, unique 12-digit `bin`, phone, email).
- `public.profiles` table (linked 1:1 to `auth.users`, linked to a company,
  `role`, `is_active`).
- A trigger on `auth.users` that automatically creates/links a company and a
  profile whenever a new user signs up, based on the `company_name`, `bin`,
  `contact_person`, `phone` values passed in `signUp(..., { data })`.
- `updated_at` triggers for both tables.
- Row Level Security on both tables:
  - `profiles`: a user can only **select** their own row. There is no
    update/insert/delete policy — direct writes are denied entirely.
  - `companies`: a user can only **select** the company referenced by their
    own profile. No insert/update/delete policy for clients.
  - A `update_my_profile(p_full_name, p_phone)` RPC function (SECURITY
    DEFINER) is the only way to change a profile, and it only ever touches
    `full_name` and `phone` — `role`, `company_id`, and `is_active` can never
    be changed by a client.
- A one-time backfill block that creates a company/profile for any
  `auth.users` row that doesn't have a profile yet (for users registered
  before this migration existed). It never touches existing profiles/companies.

No `service_role` key is used anywhere in this migration or in the app code.
RLS is enabled (not disabled) on every new table.

## How to apply it

1. Open your project in the [Supabase dashboard](https://supabase.com/dashboard).
2. Go to **SQL Editor** → **New query**.
3. Open `supabase/migrations/001_companies_and_profiles.sql` in this repo,
   copy its full contents, and paste them into the SQL Editor.
4. Click **Run**. The script is idempotent (safe to run more than once) —
   it uses `create table if not exists`, `create or replace function`,
   `drop trigger/policy if exists`, and only backfills users that don't
   already have a profile.
5. Check for errors in the editor output. If something fails partway
   through, fix the reported statement and re-run the whole script; it will
   skip everything that already exists.

## Verifying the result

### Tables exist

In **Table Editor**, confirm you see `companies` and `profiles` under the
`public` schema, with the columns described above.

Or via SQL Editor:

```sql
select table_name from information_schema.tables
where table_schema = 'public' and table_name in ('companies', 'profiles');
```

### RLS is enabled

```sql
select relname, relrowsecurity
from pg_class
where relname in ('companies', 'profiles');
```

Both rows should show `relrowsecurity = true`.

```sql
select polname, tablename, cmd
from pg_policies
where schemaname = 'public'
order by tablename, polname;
```

You should see exactly one `select`-only policy for `companies`
(`companies_select_own`) and one for `profiles` (`profiles_select_own`), and
no insert/update/delete policies on either table.

### Trigger + auto profile creation

1. Go to `/register` in the app and sign up a new test user with a company
   name, a 12-digit BIN, a contact person, and a phone number.
2. If the project requires email confirmation, confirm the email from the
   inbox, then log in at `/login`.
3. In the Supabase Table Editor, open `profiles` and confirm a row exists
   with the new user's `id`, correct `full_name`/`phone`, `role = client`,
   and a non-null `company_id`.
4. Open `companies` and confirm a row exists with the matching `bin`/`name`,
   and that `profiles.company_id` points to it.
5. Register a second user with the **same BIN** and confirm no second
   `companies` row is created — the second profile should link to the
   existing company instead.

### Existing (pre-migration) test users

If you already created a test user before this migration existed, they will
not have a `profiles` row from the trigger (the trigger only fires on new
inserts into `auth.users`). The migration's backfill block (`step 8` in the
SQL file) handles this automatically the first time you run the migration —
it scans `auth.users` for any row missing a `profiles` row and creates the
company/profile from that user's `raw_user_meta_data`.

If you ever need to do this manually for a single user instead, you can run:

```sql
-- Replace the UUID with the user's auth.users.id
select id, email, raw_user_meta_data from auth.users where id = '00000000-0000-0000-0000-000000000000';

-- Then, using the values from that row:
insert into public.companies (name, bin, phone, email)
values ('<company_name>', '<bin>', '<phone>', '<email>')
on conflict (bin) do nothing;

insert into public.profiles (id, company_id, full_name, phone, role)
values (
  '00000000-0000-0000-0000-000000000000',
  (select id from public.companies where bin = '<bin>'),
  '<contact_person>',
  '<phone>',
  'client'
)
on conflict (id) do nothing;
```

No existing users are ever deleted by this migration.

## Explicitly not done in this migration

- No `orders`, `products`, `invoices`, or `payments` tables.
- No admin UI or role management UI.
- No use of the `service_role` key anywhere in client code.
- No automatic `supabase gen types` run — TypeScript types were written by
  hand in `src/types/database.ts` and should be kept in sync manually (or
  replaced later by generated types).
