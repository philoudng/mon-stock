-- Mon Stock : copie en ligne des données (une ligne par mouvement).
-- À coller une seule fois dans Supabase → SQL Editor → Run.
-- Chaque compte ne voit et ne modifie que ses propres lignes (Row Level Security).

create table if not exists public.stock_entries (
  user_id    uuid        not null default auth.uid() references auth.users (id) on delete cascade,
  id         text        not null,
  data       jsonb,
  deleted    boolean     not null default false,
  updated_at timestamptz not null default clock_timestamp(),
  primary key (user_id, id)
);
create index if not exists stock_entries_user_updated on public.stock_entries (user_id, updated_at);

alter table public.stock_entries enable row level security;

drop policy if exists "lire ses lignes" on public.stock_entries;
drop policy if exists "ajouter ses lignes" on public.stock_entries;
drop policy if exists "modifier ses lignes" on public.stock_entries;
drop policy if exists "supprimer ses lignes" on public.stock_entries;
create policy "lire ses lignes"      on public.stock_entries for select to authenticated using ((select auth.uid()) = user_id);
create policy "ajouter ses lignes"   on public.stock_entries for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "modifier ses lignes"  on public.stock_entries for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "supprimer ses lignes" on public.stock_entries for delete to authenticated using ((select auth.uid()) = user_id);

grant select, insert, update, delete on public.stock_entries to authenticated;
revoke all on public.stock_entries from anon;

-- Heure du serveur à chaque écriture (sert à savoir ce qui a changé depuis la dernière synchronisation)
create or replace function public.stock_touch() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := clock_timestamp();
  return new;
end $$;

drop trigger if exists stock_touch on public.stock_entries;
create trigger stock_touch before insert or update on public.stock_entries
for each row execute function public.stock_touch();
