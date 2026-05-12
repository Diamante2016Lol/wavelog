// =============================================================================
// oracle.mjs — WaveLog Ensemble Forecaster (Versión Bimotor Corregida)
// =============================================================================

import { createClient } from '@supabase/supabase-js';

// ---------------------------------------------------------------------------
// CONFIGURACION
// ---------------------------------------------------------------------------
const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

const LAT = 41.38;
const LON = 2.15;
const FORECAST_DAYS = 3;

// NOMBRES REALES DE LOS MODELOS PARA LA API DE PRONÓSTICO
const OPEN_METEO_MODELS = {
  ibi:   'best_match',      // Fallback seguro para IBI
  ecmwf: 'ecmwf_wave',      // El modelo europeo real de olas
  gfs:   'gfs_wave',        // El modelo americano real de olas
  icon:  'icon_wave'        // El modelo alemán real de olas
};

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

async function run_oracle() {
  console.log('--- WaveLog Oracle: Iniciando proceso diario ---');

  // 1. DESCARGAR PRONOSTICO (CON MANEJO DE ERRORES MEJORADO)
  console.log('[1/4] Solicitando pronostico a Open-Meteo...');
  const model_list = Object.values(OPEN_METEO_MODELS).join(',');
  const url = `https://marine-api.open-meteo.com/v1/marine?latitude=${LAT}&longitude=${LON}&hourly=wave_height,wave_period,wave_direction&models=${model_list}&forecast_days=${FORECAST_DAYS}`;

  const response = await fetch(url);
  
  if (!response.ok) {
    const errorText = await response.text();
    console.error(`Error en Open-Meteo (Status ${response.status}):`);
    console.error(errorText);
    throw new Error('La API de Open-Meteo ha rechazado la peticion. Revisa los nombres de los modelos.');
  }

  const data = await response.json();
  const h = data.hourly;

  // 2. LEER PESOS ENTRENADOS (IA)
  console.log('[2/4] Leyendo pesos de la IA desde Supabase...');
  const { data: weightsData, error: wError } = await supabase
    .from('ai_weights')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(1);

  if (wError || !weightsData || weightsData.length === 0) {
    console.log('Aviso: No se han encontrado pesos entrenados. Se usara el promedio simple.');
  }

  const ai = weightsData?.[0] || { weights: { hs_ibi: 0.25, hs_ecmwf: 0.25, hs_gfs: 0.25, hs_icon: 0.25 }, bias: 0 };
  const w = ai.weights;

  // 3. CALCULAR PREDICCION HORA A HORA
  console.log('[3/4] Calculando prediccion personalizada...');
  const filas = h.time.map((t, i) => {
    // Extraemos valores de cada modelo
    const val_ibi   = h.wave_height_best_match?.[i] || 0;
    const val_ecmwf = h.wave_height_ecmwf_wave?.[i] || 0;
    const val_gfs   = h.wave_height_gfs_wave?.[i] || 0;
    const val_icon  = h.wave_height_icon_wave?.[i] || 0;

    // Aplicamos la formula del Oráculo
    // Nota: Como entrenamos con IBI e ICON a cero, sus pesos seran 0 y no afectaran.
    const hs_ai = (val_ibi * w.hs_ibi) + (val_ecmwf * w.hs_ecmwf) + (val_gfs * w.hs_gfs) + (val_icon * w.hs_icon) + ai.bias;

    return {
      timestamp: t,
      forecast_date: t.split('T')[0],
      forecast_hour: parseInt(t.split('T')[1].split(':')[0]),
      hs_ai: Math.max(0, hs_ai), // Evitamos valores negativos
      // Guardamos tambien los modelos base por si queremos compararlos en la web
      ibi_hs: val_ibi,
      ecmwf_hs: val_ecmwf,
      gfs_hs: val_gfs,
      icon_hs: val_icon,
      tp_ai: h.wave_period_ecmwf_wave?.[i] || 0,
      dir_ai: h.wave_direction_ecmwf_wave?.[i] || 0
    };
  });

  // 4. GUARDAR EN SUPABASE
  console.log(`[4/4] Guardando ${filas.length} filas en forecast_ai...`);
  const { error: upsertError } = await supabase
    .from('forecast_ai')
    .upsert(filas, { onConflict: 'timestamp' });

  if (upsertError) throw upsertError;

  console.log('--- Oracle finalizado con exito ---');
}

run_oracle().catch(err => {
  console.error('ERROR CRITICO EN EL ORACULO:');
  console.error(err);
  process.exit(1);
});
