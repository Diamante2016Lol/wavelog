-- Histórico de TODAS las pasadas del oracle (no se sobrescribe nunca).
-- Ejecutar una vez en Supabase → SQL Editor.
create table if not exists public.forecast_runs (
  id          bigint generated always as identity primary key,
  run_time    timestamptz not null,   -- cuándo se ejecutó el oracle (hora redondeada, UTC)
  valid_time  timestamptz not null,   -- hora pronosticada (UTC)
  lead_hours  integer     not null,   -- antelación = valid_time - run_time
  ecmwf_hs    real,
  gfs_hs      real,
  mfwam_hs    real,                   -- MeteoFrance MFWAM (antes "ibi")
  ewam_hs     real,                   -- DWD EWAM (antes "icon")
  hs_ai       real,
  tp          real,
  dir         real,
  metodo      text,
  created_at  timestamptz not null default now(),
  unique (run_time, valid_time)
);

create index if not exists forecast_runs_valid_idx on public.forecast_runs (valid_time);
create index if not exists forecast_runs_lead_idx  on public.forecast_runs (lead_hours);

-- Lectura pública (la web usa la anon key); la escritura solo con service role.
alter table public.forecast_runs enable row level security;
drop policy if exists "forecast_runs lectura publica" on public.forecast_runs;
create policy "forecast_runs lectura publica" on public.forecast_runs
  for select using (true);
