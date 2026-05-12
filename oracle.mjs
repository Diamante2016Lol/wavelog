import { createClient } from '@supabase/supabase-js';

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY; 

// Clasificador de ventanas
function getVentana(dir) {
  if (dir >= 337.5 || dir < 67.5) return 'NE';
  if (dir >= 67.5 && dir < 112.5) return 'E';
  if (dir >= 112.5 && dir < 157.5) return 'SE';
  if (dir >= 157.5 && dir < 202.5) return 'S';
  return 'SW'; // Todo lo que va de 202.5 a 337.5 (Oeste/SurOeste)
}

async function run() {
  console.log('--- WaveLog Oracle: Iniciando (5 Ventanas Direccionales) ---');
  
  if (!url || !key) {
    console.error('Error: Faltan credenciales.');
    process.exit(1);
  }

  const supabase = createClient(url, key, { auth: { persistSession: false }, realtime: { enabled: false } });

  // 1. Descarga de datos
  const api = `https://marine-api.open-meteo.com/v1/marine?latitude=41.38&longitude=2.15&hourly=wave_height,wave_period,wave_direction&models=ecmwf_wam025,ncep_gfswave016,best_match&forecast_days=3`;
  const res = await fetch(api);
  const data = await res.json();
  const h = data.hourly;

  // 2. Cargar el cerebro de la IA
  const { data: wData } = await supabase.from('ai_weights').select('*').order('id', { ascending: false }).limit(1);
  
  // Objeto con pesos por defecto si la IA no ha sido entrenada aun
  const defaultWeights = { hs_ecmwf: 0.5, hs_gfs: 0.5, bias: 0 };
  const w = wData?.[0]?.weights || { NE: defaultWeights, E: defaultWeights, SE: defaultWeights, S: defaultWeights, SW: defaultWeights };

  // 3. Procesar
  const filas = h.time.map((t, i) => {
    const e = h.wave_height_ecmwf_wam025?.[i] || 0;
    const g = h.wave_height_ncep_gfswave016?.[i] || 0;
    const best = h.wave_height_best_match?.[i] || 0;
    const dir = h.wave_direction_ecmwf_wam025?.[i] || 180;
    
    // Identificar ventana y sacar sus multiplicadores
    const ventana = getVentana(dir);
    const conf = w[ventana] || defaultWeights;
    
    const hs_final = (e * (conf.hs_ecmwf || 0)) + (g * (conf.hs_gfs || 0)) + (conf.bias || 0);

    return {
      timestamp: t,
      forecast_date: t.split('T')[0],
      forecast_hour: parseInt(t.split('T')[1]),
      hs_ai: Math.max(0.1, hs_final),
      tp_ai: h.wave_period_ecmwf_wam025?.[i] || 8,
      dir_ai: dir,
      ibi_hs: best,
      ecmwf_hs: e,
      gfs_hs: g,
      icon_hs: best,
      quality_score: hs_final > 1.2 ? 5 : (hs_final > 0.7 ? 4 : 3)
    };
  });

  // 4. Guardar
  const { error } = await supabase.from('forecast_ai').upsert(filas, { onConflict: 'timestamp' });
  if (error) throw error;
  console.log('Pronostico guardado con exito.');
}

run().catch(e => { console.error('Fallo:', e.message); process.exit(1); });
