# Supabase setup for DEKORO Platform V1

This document describes how to apply the SQL in `supabase/migrations` and
`supabase/seed` by hand, since the project does not use the Supabase CLI
yet. **Nothing here is executed automatically** — you must run each file
yourself in the Supabase SQL Editor, in order.

## Run order

1. Run `supabase/migrations/001_companies_and_profiles.sql`.
2. Run `supabase/migrations/002_catalog_inventory_pricing.sql`.
3. Run `supabase/seed/001_catalog_demo.sql`.
4. Check the tables (see "Verifying the result" below for both migrations).
5. Set `NEXT_PUBLIC_USE_SUPABASE_CATALOG=true` in `.env.local`.
6. Restart `npm run dev`.
7. Check `/catalog`, a product page, and `/cart` — they should look exactly
   the same as with the static catalog, just now backed by Supabase.

Each SQL file starts with a small guard block that raises a clear error if
you run it out of order (e.g. running `002_...` before `001_...`).

## How to apply a SQL file

1. Open your project in the [Supabase dashboard](https://supabase.com/dashboard).
2. Go to **SQL Editor** → **New query**.
3. Open the file in this repo, copy its full contents, and paste them into
   the SQL Editor.
4. Click **Run**.
5. Check for errors in the editor output. If something fails partway
   through, fix the reported statement and re-run the whole file — every
   file in this project is written to be safe to re-run (idempotent):
   `create table if not exists`, `create or replace function`,
   `drop trigger/policy if exists` + recreate, `on conflict do update/nothing`
   for seed data, and guarded `create type`/index creation.

---

## Migration 001: companies & profiles

### What it creates

- `user_role` enum: `client`, `manager`, `accountant`, `warehouse`, `admin`.
- `public.companies` table (name, unique 12-digit `bin`, phone, email, and —
  as of migration 002 — `price_group_id`).
- `public.profiles` table (linked 1:1 to `auth.users`, linked to a company,
  `role`, `is_active`).
- `public.set_updated_at()` — shared trigger function reused by every table
  in this project that has an `updated_at` column.
- A trigger on `auth.users` that automatically creates/links a company and a
  profile whenever a new user signs up, based on the `company_name`, `bin`,
  `contact_person`, `phone` values passed in `signUp(..., { data })`.
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
  `auth.users` row that doesn't have a profile yet.

### Verifying the result

```sql
select table_name from information_schema.tables
where table_schema = 'public' and table_name in ('companies', 'profiles');

select relname, relrowsecurity from pg_class
where relname in ('companies', 'profiles');
-- both rows should show relrowsecurity = true

select polname, tablename, cmd from pg_policies
where schemaname = 'public' order by tablename, polname;
-- one select-only policy each for companies and profiles, no writes
```

To confirm the trigger works end-to-end: register a new user at `/register`
with a company name, a 12-digit BIN, a contact person and a phone number,
confirm the email if required, then check that matching rows appear in
`profiles` and `companies` in the Table Editor. Registering a second user
with the same BIN should link to the existing company instead of creating a
duplicate.

If you had test users created **before** this migration existed, the
backfill block in the migration handles them automatically the first time
you run it (it only touches `auth.users` rows that don't have a `profiles`
row yet — no existing user or profile is ever altered or deleted).

---

## Migration 002: catalog, warehouses, inventory & pricing

### What it creates

- `product_status` enum: `draft`, `active`, `archived`.
- `public.categories`, `public.products`, `public.product_images` — the
  catalog itself. A product has at most one primary image (enforced with a
  partial unique index, not a trigger).
- `public.warehouses`, `public.inventory` — stock per product per warehouse
  (`reserved_quantity <= quantity` is enforced by a check constraint).
- `public.product_availability` — a plain view over `inventory` that adds
  `available_quantity = quantity - reserved_quantity`. It exists mainly for
  future internal/warehouse tooling; clients never query it directly (see
  RLS notes below).
- `public.price_groups` (at most one `is_default = true`, enforced with a
  partial unique index), `public.product_prices` (price per product per
  price group, with optional `valid_from`/`valid_to`), and
  `public.company_product_prices` (a company's personal price for a
  product — takes priority over its price group's price).
- `companies.price_group_id` — added to the existing `companies` table.
- `get_product_price(p_product_id uuid)`: resolves the **current user's**
  price for a product, in priority order: their company's personal price
  (`company_product_prices`) → their company's price group
  (`product_prices`, falling back to the default price group if the company
  has none assigned) → `products.base_price`. Respects `valid_from`/
  `valid_to`. Returns `null` for unauthenticated callers (matching the
  existing "price available after sign-in" behavior). SECURITY DEFINER,
  locked `search_path`.
- `get_catalog()`: returns all active products in one round trip —
  `product_id, name, sku, original_sku, category, dimensions, unit,
  available_stock, sale_price, image, is_promotion` — with `available_stock`
  summed across active warehouses and `sale_price` resolved per-caller via
  `get_product_price()`. This is what `CatalogContext` calls instead of
  issuing a separate price query per product (no N+1). SECURITY DEFINER,
  locked `search_path`.
- `updated_at` triggers on `categories`, `products`, `warehouses`,
  `inventory`, `price_groups`, `product_prices`, `company_product_prices`,
  reusing `public.set_updated_at()` from migration 001.

### Row Level Security

RLS is enabled on every table above. Direct client access (`anon` and
`authenticated`) is:

| Table                      | Client SELECT                          | Client INSERT/UPDATE/DELETE |
| --------------------------- | --------------------------------------- | ---------------------------- |
| `categories`                | rows where `is_active = true`           | denied |
| `products`                  | rows where `status = 'active'`          | denied |
| `product_images`            | images of active products               | denied |
| `warehouses`                | rows where `is_active = true`           | denied |
| `inventory`                 | **denied** (no policy at all)           | denied |
| `product_availability` view | **denied** (not granted)                | denied |
| `price_groups`              | **denied** (no policy at all)           | denied |
| `product_prices`            | **denied** (no policy at all)           | denied |
| `company_product_prices`    | **denied** (no policy at all)           | denied |

Stock and pricing are intentionally **not** readable directly by clients —
they are only ever exposed through the `get_catalog()` / `get_product_price()`
RPCs (both SECURITY DEFINER), which return only the aggregated/resolved
numbers a client needs (`available_stock`, `sale_price`), never raw
`quantity`/`reserved_quantity` or other companies' price lists.

### Verifying the result

```sql
select table_name from information_schema.tables
where table_schema = 'public'
  and table_name in (
    'categories', 'products', 'product_images', 'warehouses',
    'inventory', 'price_groups', 'product_prices', 'company_product_prices'
  );

select relname, relrowsecurity from pg_class
where relname in (
  'categories', 'products', 'product_images', 'warehouses',
  'inventory', 'price_groups', 'product_prices', 'company_product_prices'
);
-- every row should show relrowsecurity = true

select proname from pg_proc
where pronamespace = 'public'::regnamespace
  and proname in ('get_product_price', 'get_catalog');
```

After running the seed file (next section), you can sanity-check the RPCs
directly in the SQL Editor (running as the `postgres` role bypasses RLS, so
`auth.uid()` will be null there — this just confirms the function runs and
falls back to `base_price`):

```sql
select * from public.get_catalog();
select public.get_product_price(id) from public.products limit 1;
```

To see personalized pricing, call these from the app once signed in (e.g.
via `supabase.rpc('get_catalog')` in the browser console on a page that has
the Supabase client loaded) rather than from the SQL Editor.

---

## Seed: demo catalog data

`supabase/seed/001_catalog_demo.sql` inserts:

- 3 categories: «Бамбуковые панели», «Луверы», «Алюминиевые профили».
- 1 warehouse: «Основной склад Алматы» (`code = ALMATY-01`).
- 1 price group: «Базовая» (`is_default = true`).
- 5 demo products using real DEKORO SKUs from the current static catalog
  (`Y01-1189`, `J36-507`, `J35-502`, `L-010`, `A-100`), with their
  `dimensions`, `unit`, and `base_price`.
- Stock for each of those 5 products at the demo warehouse.
- A `product_prices` row per product in the «Базовая» group, mirroring
  `base_price`.

Every insert is keyed off a natural unique column (`slug`, `sku`, `code`,
`name`) with `on conflict ... do update`, so running this file again updates
the same demo rows instead of creating duplicates.

---

## Switching the app to the Supabase catalog

The app reads `NEXT_PUBLIC_USE_SUPABASE_CATALOG` (see `.env.example`):

- `false` (default) — `/catalog`, `/product/[id]` and the cart use the
  static catalog in `src/data/products.ts`, exactly as before. This is safe
  even if migration 002 hasn't been run yet — `CatalogContext` never talks
  to Supabase while the flag is off.
- `true` — those pages read from `CatalogContext`, which calls
  `get_catalog()` once and maps the rows into the same `Product` shape the
  UI already expects, so nothing about the catalog/product/cart pages
  should look different.

Set the flag in `.env.local` and restart `npm run dev` for it to take
effect (it's a build-time `NEXT_PUBLIC_*` variable).

## Supabase Storage (future step)

No storage bucket is created yet. `product_images.image_url` is a plain
text column for now. On the next iteration, a `product-images` bucket will
be created (with its own access policy) and `image_url` will point to
objects in that bucket instead of external URLs.

## Explicitly not done in these migrations

- No `orders`, `invoices`, or `payments` tables.
- No admin UI or role management UI.
- No Supabase Storage bucket yet (see above).
- No use of the `service_role` key anywhere in client code.
- No automatic `supabase gen types` run — TypeScript types were written by
  hand in `src/types/database.ts` and should be kept in sync manually (or
  replaced later by generated types).
- The static catalog (`src/data/products.ts`) has not been deleted — it
  remains the default data source until the Supabase catalog is fully
  verified and the feature flag is flipped intentionally.
