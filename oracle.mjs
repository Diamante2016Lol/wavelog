import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const LAT = 41.38;
const LON = 2.15;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

async function ejecutarOraculo() {
  console.log('--- WaveLog Oracle: Iniciando ---');

  // 1. DESCARGAR DATOS (Nombres exactos validados)
  console.log('[1/4] Solicitando datos reales a Open-Meteo...');
  
  // Usamos los nombres que el diagnostico dio como COMPATIBLES
  const modelos = "ecmwf_wam025,ncep_gfswave016,best_match";
  const url = `https://marine-api.open-meteo.com/v1/marine?latitude=${LAT}&longitude=${LON}&hourly=wave_height,wave_period,wave_direction&models=${modelos}&forecast_days=3`;

  const response = await fetch(url);
  if (!response.ok) {
    const errorTxt = await response.text();
    throw new Error(`Open-Meteo rechazo la peticion: ${errorTxt}`);
  }
  
  const data = await response.json();
  const h = data.hourly;

  // 2. LEER PESOS DE LA IA
  console.log('[2/4] Cargando pesos desde ai_weights...');
  const { data: wData, error: wErr } = await supabase
    .from('ai_weights')
    .select('weights, bias')
    .order('id', { ascending: false })
    .limit(1);

  // Valores por defecto por si la tabla esta vacia
  let w = { hs_ibi: 0, hs_ecmwf: 0.5, hs_gfs: 0.5, hs_icon: 0 };
  let bias = 0;

  if (wErr || !wData || wData.length === 0) {
    console.log('⚠️ Aviso: No se hallaron pesos. Usando mezcla 50/50 de seguridad.');
  } else {
    w = wData[0].weights;
    bias = wData[0].bias || 0;
    console.log('✅ Inteligencia cargada correctamente.');
  }

  // 3. CALCULAR PREDICCION
  console.log('[3/4] Aplicando formula del Oraculo...');
  const filas = h.time.map((t, i) => {
    
    // Extraemos valores con los nombres exactos que devuelve la API
    const val_ecmwf = h.wave_height_ecmwf_wam025 ? h.wave_height_ecmwf_wam025[i] : (h.wave_height[i] || 0);
    const val_gfs   = h.wave_height_ncep_gfswave016 ? h.wave_height_ncep_gfswave016[i] : (h.wave_height[i] || 0);
    
    // Calculo Hs: IBI e ICON van multiplicados por cero segun nuestro entrenamiento Bimotor
    let hs_final = (val_ecmwf * (w.hs_ecmwf || 0)) + (val_gfs * (w.hs_gfs || 0)) + bias;

    return {
      timestamp: t,
      forecast_date: t.split('T')[0],
      forecast_hour: parseInt(t.split('T')[1].split(':')[0]),
      hs_ai: Math.max(0.1, hs_final), 
      ibi_hs: 0,
      ecmwf_hs: val_ecmwf,
      gfs_hs: val_gfs,
      icon_hs: 0,
      tp_ai: h.wave_period ? h.wave_period[i] : 8,
      dir_ai: h.wave_direction ? h.wave_direction[i] : 180
    };
  });

  // 4. GUARDAR RESULTADOS
  console.log(`[4/4] Subiendo ${filas.length} horas de pronostico a forecast_ai...`);
  const { error: upErr } = await supabase
    .from('forecast_ai')
    .upsert(filas, { onConflict: 'timestamp' });

  if (upErr) throw upErr;
  console.log('--- ¡ORACULO COMPLETADO CON EXITO! ---');
}

ejecutarOraculo().catch(err => {
  console.error('Fallo en el Oraculo:', err.message);
  process.exit(1);
});
