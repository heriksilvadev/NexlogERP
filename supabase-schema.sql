-- Execute este arquivo no SQL Editor do Supabase.
create extension if not exists pgcrypto;

create table if not exists public.nexlog_records (
  id uuid primary key default gen_random_uuid(),
  collection text not null,
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists nexlog_records_collection_idx
  on public.nexlog_records (collection);

alter table public.nexlog_records enable row level security;

drop policy if exists "Authenticated users can read NEXLOG records" on public.nexlog_records;
create policy "Authenticated users can read NEXLOG records"
  on public.nexlog_records for select to authenticated using (true);

drop policy if exists "Authenticated users can insert NEXLOG records" on public.nexlog_records;
create policy "Authenticated users can insert NEXLOG records"
  on public.nexlog_records for insert to authenticated with check (true);

drop policy if exists "Authenticated users can update NEXLOG records" on public.nexlog_records;
create policy "Authenticated users can update NEXLOG records"
  on public.nexlog_records for update to authenticated using (true) with check (true);

drop policy if exists "Authenticated users can delete NEXLOG records" on public.nexlog_records;
create policy "Authenticated users can delete NEXLOG records"
  on public.nexlog_records for delete to authenticated using (true);

-- Perfis usados pela aplicação. As senhas ficam exclusivamente no Supabase Auth.
insert into public.nexlog_records (collection, data)
select 'users', x.data
from (values
  ('{"nome":"Administrador","usuario":"admin","perfil":"Administrador","status":"Ativo","created_at": now()}'::jsonb),
  ('{"nome":"Equipe de Produção","usuario":"producao","perfil":"Produção","status":"Ativo","created_at": now()}'::jsonb),
  ('{"nome":"Equipe de Qualidade","usuario":"qualidade","perfil":"Qualidade","status":"Ativo","created_at": now()}'::jsonb)
) as x(data)
where not exists (
  select 1 from public.nexlog_records where collection = 'users'
);

-- Ative Realtime para atualizações entre computadores.
do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'nexlog_records'
  ) then
    alter publication supabase_realtime add table public.nexlog_records;
  end if;
end $$;
