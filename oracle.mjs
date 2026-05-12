import { createClient } from '@supabase/supabase-js';

// Buscamos exactamente el nombre que mencionas
const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY; 

async function ejecutar() {
  console.log('--- WaveLog Oracle: Verificando Credenciales ---');
  
  if (!url || !key) {
    console.error('❌ ERROR: No se encuentran las llaves.');
    console.error('URL:', url ? 'OK' : 'VACIA');
    console.error('KEY:', key ? 'OK' : 'VACIA');
    process.exit(1);
  }

  const supabase = createClient(url, key);
  console.log('✅ Conectado a Supabase. Descargando datos...');

  // 1. Descarga de Open-Meteo
  const api = `https://marine-api.open-meteo.com/v1/marine?latitude=41.38&longitude=2.15&hourly=wave_height,wave_period,wave_direction&models=ecmwf_wam025,ncep_gfswave016&forecast_days=3`;
  const res = await fetch(api);
  const data = await res.json();

  // 2. Cargar Pesos IA
  const { data: wData } = await supabase.from('ai_weights').select('*').order('id', { ascending: false }).limit(1);
  let w = wData && wData[0] ? wData[0].weights : { hs_ecmwf: 0.5, hs_gfs: 0.5 };
  let bias = wData && wData[0] ? wData[0].bias : 0;

  // 3. Calcular
  const filas = data.hourly.time.map((t, i) => {
    const e = data.hourly.wave_height_ecmwf_wam025[i] || 0;
    const g = data.hourly.wave_height_ncep_gfswave016[i] || 0;
    return {
      timestamp: t,
      forecast_date: t.split('T')[0],
      forecast_hour: parseInt(t.split('T')[1]),
      hs_ai: Math.max(0.1, (e * (w.hs_ecmwf || 0.5)) + (g * (w.hs_gfs || 0.5)) + (bias || 0)),
      ibi_hs: 0, ecmwf_hs: e, gfs_hs: g, icon_hs: 0,
      tp_ai: data.hourly.wave_period[i] || 8,
      dir_ai: data.hourly.wave_direction[i] || 180
    };
  });

  // 4. Guardar
  const { error } = await supabase.from('forecast_ai').upsert(filas, { onConflict: 'timestamp' });
  if (error) throw error;

  console.log('🚀 ¡TODO EN VERDE! Pronostico guardado con exito.');
}

ejecutar().catch(e => { console.error('Error:', e.message); process.exit(1); });
