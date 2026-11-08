-- ECMWF ENS de olas (último run) en el punto de Barcelona. Lo rellena scripts/ens.py.
-- Ejecutar una vez en Supabase → SQL Editor.
create table if not exists public.ens_waves (
  valid_time  timestamptz primary key,  -- hora pronosticada (UTC)
  run_time    timestamptz not null,     -- run del ENS (00z / 12z)
  lead_hours  integer     not null,
  n           integer     not null,     -- miembros con dato
  p10 real, p25 real, p50 real, p75 real, p90 real,
  miembros    real[]      not null,     -- Hs de cada miembro
  updated_at  timestamptz not null default now()
);

alter table public.ens_waves enable row level security;
drop policy if exists "ens_waves lectura publica" on public.ens_waves;
create policy "ens_waves lectura publica" on public.ens_waves for select using (true);
