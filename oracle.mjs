import { createClient } from '@supabase/supabase-js';

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY; 

async function run() {
  const supabase = createClient(url, key, { auth: { persistSession: false }, realtime: { enabled: false } });

  // 1. Obtener datos de Open-Meteo
  const api = `https://marine-api.open-meteo.com/v1/marine?latitude=41.38&longitude=2.15&hourly=wave_height,wave_period,wave_direction&models=ecmwf_wam025,ncep_gfswave016,best_match&forecast_days=3`;
  const res = await fetch(api);
  const data = await res.json();
  const h = data.hourly;

  // 2. Cargar pesos de la IA
  const { data: wData } = await supabase.from('ai_weights').select('*').order('id', { ascending: false }).limit(1);
  const w = wData?.[0]?.weights || { hs_ecmwf: 0.5, hs_gfs: 0.5 };
  const bias = wData?.[0]?.bias || 0;

  // 3. Mapear datos a las columnas nuevas
  const filas = h.time.map((t, i) => {
    const e = h.wave_height_ecmwf_wam025?.[i] || 0;
    const g = h.wave_height_ncep_gfswave016?.[i] || 0;
    const best = h.wave_height_best_match?.[i] || 0;

    return {
      timestamp: t,
      forecast_date: t.split('T')[0],
      forecast_hour: parseInt(t.split('T')[1]),
      hs_ai: Math.max(0.1, (e * (w.hs_ecmwf || 0)) + (g * (w.hs_gfs || 0)) + bias),
      tp_ai: h.wave_period_ecmwf_wam025?.[i] || 8,
      dir_ai: h.wave_direction_ecmwf_wam025?.[i] || 180,
      ibi_hs: best,
      ecmwf_hs: e,
      gfs_hs: g,
      icon_hs: best
    };
  });

  // 4. Guardar
  const { error } = await supabase.from('forecast_ai').upsert(filas, { onConflict: 'timestamp' });
  if (error) throw error;
  console.log('✅ Pronóstico actualizado con éxito.');
}

run().catch(e => { console.error('❌ Error:', e.message); process.exit(1); });
