import { createClient } from '@supabase/supabase-js';

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY; 

async function run() {
  console.log('--- WaveLog Oracle: Iniciando Proceso ---');
  
  if (!url || !key) {
    console.error('Error: Faltan credenciales en GitHub Secrets.');
    process.exit(1);
  }

  const supabase = createClient(url, key, {
    auth: { persistSession: false },
    realtime: { enabled: false } 
  });

  // 1. Descarga de datos
  const api = `https://marine-api.open-meteo.com/v1/marine?latitude=41.38&longitude=2.15&hourly=wave_height,wave_period,wave_direction&models=ecmwf_wam025,ncep_gfswave016,best_match&forecast_days=3`;
  const res = await fetch(api);
  const data = await res.json();
  const h = data.hourly;

  // 2. Cargar pesos de IA
  const { data: wData } = await supabase.from('ai_weights').select('*').order('id', { ascending: false }).limit(1);
  const w = wData?.[0]?.weights || { hs_ecmwf: 0.5, hs_gfs: 0.5 };
  const bias = wData?.[0]?.bias || 0;

  // 3. Procesar filas
  const filas = h.time.map((t, i) => {
    const e = h.wave_height_ecmwf_wam025?.[i] || 0;
    const g = h.wave_height_ncep_gfswave016?.[i] || 0;
    const best = h.wave_height_best_match?.[i] || 0;
    
    const hs_final = (e * (w.hs_ecmwf || 0)) + (g * (w.hs_gfs || 0)) + bias;

    return {
      timestamp: t,
      forecast_date: t.split('T')[0],
      forecast_hour: parseInt(t.split('T')[1]),
      hs_ai: Math.max(0.1, hs_final),
      tp_ai: h.wave_period_ecmwf_wam025?.[i] || 8,
      dir_ai: h.wave_direction_ecmwf_wam025?.[i] || 180,
      ibi_hs: best,
      ecmwf_hs: e,
      gfs_hs: g,
      icon_hs: best,
      quality_score: hs_final > 1.2 ? 5 : (hs_final > 0.7 ? 4 : 3)
    };
  });

  // 4. Upsert a Supabase
  const { error } = await supabase.from('forecast_ai').upsert(filas, { onConflict: 'timestamp' });
  if (error) throw error;

  console.log('🚀 Pronóstico actualizado correctamente.');
}

run().catch(e => { console.error('Fallo:', e.message); process.exit(1); });
