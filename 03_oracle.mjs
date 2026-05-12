// =============================================================================
// oracle.mjs — WaveLog Ensemble Forecaster
// Script diario ejecutado por GitHub Actions a las 06:00 UTC
//
// Pipeline:
//   1. Descargar pronostico de olas de Open-Meteo (IBI, ECMWF, GFS, ICON)
//   2. Leer pesos entrenados de la tabla ai_weights en Supabase
//   3. Aplicar la formula de regresion para calcular hs_ai
//   4. Guardar el resultado en la tabla forecast_ai (upsert por fecha y hora)
//
// Variables de entorno necesarias (configurar en GitHub Secrets):
//   SUPABASE_URL         — URL del proyecto Supabase
//   SUPABASE_SERVICE_KEY — Service Role Key (no la anon key)
// =============================================================================

import { createClient } from '@supabase/supabase-js';

// ---------------------------------------------------------------------------
// CONFIGURACION
// ---------------------------------------------------------------------------
const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

// Coordenadas del spot (Costa Catalana / Barcelona)
// Ajusta estas coordenadas a tu zona concreta
const LAT = 41.38;
const LON = 2.15;

// Dias de pronostico a guardar (Open-Meteo permite hasta 7 dias gratis)
const FORECAST_DAYS = 3;

// Correspondencia de modelos del sistema con los codigos de Open-Meteo
const OPEN_METEO_MODELS = {
  ibi:   'mfwave',     // Meteo-France Wave Model (cubre Atlantico + Mediterraneo Iberico)
  ecmwf: 'ecmwf_wam', // ECMWF Wave Action Model (global)
  gfs:   'gfs_wave',  // GFS Wave Model de NOAA (global)
  icon:  'icon_wave', // ICON Wave Model de DWD Alemania (global)
};

// Horas que consideramos "surf" para asignar calidad
// Se guardan TODAS las horas pero la calidad se calcula en cada una
const SURF_HOUR_MIN = 7;
const SURF_HOUR_MAX = 20;

// ---------------------------------------------------------------------------
// CLIENTE SUPABASE
// ---------------------------------------------------------------------------
if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('FATAL: Faltan las variables de entorno SUPABASE_URL o SUPABASE_SERVICE_KEY.');
  process.exit(1);
}
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// ---------------------------------------------------------------------------
// UTILIDADES
// ---------------------------------------------------------------------------

// Convierte grados meteorologicos a punto cardinal (N, NE, E, SE, S, SO, O, NO)
function grados_a_cardinal(grados) {
  if (grados === null || grados === undefined || isNaN(grados)) return null;
  const puntos = ['N', 'NE', 'E', 'SE', 'S', 'SO', 'O', 'NO'];
  const idx    = Math.round(((grados % 360) + 360) % 360 / 45) % 8;
  return puntos[idx];
}

// Redondea a 2 decimales
function r2(v) {
  if (v === null || v === undefined || isNaN(v)) return null;
  return Math.round(v * 100) / 100;
}

// Calcula puntuacion de surf (1-5 estrellas) basandose en hs_ai
// Ajusta estos umbrales a tu zona geografica
function calcular_calidad(hs_ai) {
  if (hs_ai === null || hs_ai < 0) return 1;
  if (hs_ai >= 1.5 && hs_ai <= 3.0) return 5;  // Buenas-optimas
  if (hs_ai >= 1.0 && hs_ai < 1.5)  return 4;  // Muy surfeable
  if (hs_ai >= 0.7 && hs_ai < 1.0)  return 3;  // Surfeable
  if (hs_ai >= 0.4 && hs_ai < 0.7)  return 2;  // Flojita
  return 1;                                      // Plana o demasiado grande
}

// Promedio de un array ignorando nulos
function media(arr) {
  const validos = arr.filter(v => v !== null && v !== undefined && !isNaN(v));
  if (validos.length === 0) return null;
  return validos.reduce((s, v) => s + v, 0) / validos.length;
}

// ---------------------------------------------------------------------------
// PASO 1: DESCARGAR DATOS DE OPEN-METEO PARA UN MODELO CONCRETO
// ---------------------------------------------------------------------------
async function descargar_modelo(nombre, codigo_modelo) {
  const url = [
    'https://marine-api.open-meteo.com/v1/marine',
    `?latitude=${LAT}`,
    `&longitude=${LON}`,
    '&hourly=wave_height,wave_period,wave_direction',
    `&models=${codigo_modelo}`,
    `&forecast_days=${FORECAST_DAYS}`,
    '&timezone=UTC',
  ].join('');

  console.log(`  Descargando modelo ${nombre.toUpperCase()} (${codigo_modelo})...`);

  const res = await fetch(url);

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Open-Meteo devolvio error ${res.status} para modelo "${nombre}": ${body.slice(0, 200)}`);
  }

  const json = await res.json();

  if (!json.hourly || !json.hourly.time) {
    throw new Error(`Respuesta inesperada de Open-Meteo para modelo "${nombre}". Verifica las coordenadas.`);
  }

  console.log(`  Modelo ${nombre.toUpperCase()} OK — ${json.hourly.time.length} horas recibidas.`);
  return json.hourly;
}

// ---------------------------------------------------------------------------
// PASO 2: LEER LOS PESOS MAS RECIENTES DE SUPABASE
// ---------------------------------------------------------------------------
async function leer_pesos() {
  console.log('Leyendo pesos de ai_weights...');

  const { data, error } = await supabase
    .from('ai_weights')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(1);

  if (error) {
    throw new Error('Error leyendo ai_weights: ' + error.message);
  }
  if (!data || data.length === 0) {
    throw new Error(
      'No hay pesos en la tabla ai_weights. ' +
      'Abre el panel de administrador (02_admin_entrenamiento.html) ' +
      'y ejecuta el entrenamiento antes de lanzar el Oraculo.'
    );
  }

  const fila = data[0];
  console.log(`Pesos cargados (modelo #${fila.id}, entrenado el ${new Date(fila.created_at).toLocaleDateString('es-ES')})`);
  console.log(`  RMSE del modelo: ${fila.rmse ? fila.rmse.toFixed(4) + ' m' : 'no disponible'}`);
  console.log(`  R2 del modelo:   ${fila.r_squared ? fila.r_squared.toFixed(4) : 'no disponible'}`);
  return fila;
}

// ---------------------------------------------------------------------------
// PASO 3: APLICAR LA FORMULA DE REGRESION
// formula: hs_ai = bias + w_ibi*hs_ibi + w_ecmwf*hs_ecmwf + w_gfs*hs_gfs + w_icon*hs_icon
// ---------------------------------------------------------------------------
function aplicar_formula(hs_ibi, hs_ecmwf, hs_gfs, hs_icon, pesos) {
  const w = pesos.weights;
  const b = pesos.bias;

  const val =
    b +
    (w.hs_ibi   || 0) * (hs_ibi   || 0) +
    (w.hs_ecmwf || 0) * (hs_ecmwf || 0) +
    (w.hs_gfs   || 0) * (hs_gfs   || 0) +
    (w.hs_icon  || 0) * (hs_icon  || 0);

  // Clampar: la ola no puede ser negativa ni absurdamente alta
  return Math.max(0, Math.min(val, 15));
}

// Fallback: si no hay pesos (primer uso sin entrenamiento), usar media simple
function media_simple(hs_ibi, hs_ecmwf, hs_gfs, hs_icon) {
  return media([hs_ibi, hs_ecmwf, hs_gfs, hs_icon]) || 0;
}

// ---------------------------------------------------------------------------
// PASO 4: GUARDAR EN SUPABASE (UPSERT)
// ---------------------------------------------------------------------------
async function guardar_pronostico(filas) {
  if (filas.length === 0) {
    console.log('No hay filas para guardar.');
    return;
  }

  console.log(`Guardando ${filas.length} filas en forecast_ai...`);

  // Supabase limita los inserts a 1000 filas por llamada
  const CHUNK = 500;
  for (let i = 0; i < filas.length; i += CHUNK) {
    const lote = filas.slice(i, i + CHUNK);
    const { error } = await supabase
      .from('forecast_ai')
      .upsert(lote, { onConflict: 'forecast_date,forecast_hour' });

    if (error) throw new Error(`Error en upsert (lote ${i / CHUNK + 1}): ` + error.message);
    console.log(`  Lote ${Math.floor(i / CHUNK) + 1} guardado (${lote.length} filas).`);
  }
}

// ---------------------------------------------------------------------------
// FUNCION PRINCIPAL
// ---------------------------------------------------------------------------
async function main() {
  console.log('');
  console.log('========================================================');
  console.log(' WaveLog Oracle — Inicio de ejecucion');
  console.log(' Fecha UTC:', new Date().toISOString());
  console.log('========================================================');

  // 1. Descargar datos de Open-Meteo
  console.log('\n[1/4] Descargando modelos de Open-Meteo...');
  const [dataIbi, dataEcmwf, dataGfs, dataIcon] = await Promise.all([
    descargar_modelo('ibi',   OPEN_METEO_MODELS.ibi),
    descargar_modelo('ecmwf', OPEN_METEO_MODELS.ecmwf),
    descargar_modelo('gfs',   OPEN_METEO_MODELS.gfs),
    descargar_modelo('icon',  OPEN_METEO_MODELS.icon),
  ]);

  const totalHoras = dataIbi.time.length;
  console.log(`\nTotal de horas descargadas: ${totalHoras}`);

  // 2. Leer pesos
  console.log('\n[2/4] Leyendo pesos entrenados...');
  let pesos = null;
  let usar_media_simple = false;
  try {
    pesos = await leer_pesos();
  } catch (err) {
    console.warn('AVISO: ' + err.message);
    console.warn('Se usara media simple de los 4 modelos como fallback.');
    usar_media_simple = true;
  }

  // 3. Construir filas del pronostico hora a hora
  console.log('\n[3/4] Calculando predicciones IA...');
  const filas = [];

  for (let i = 0; i < totalHoras; i++) {
    const tiempo_str = dataIbi.time[i]; // "2024-01-15T06:00"
    const [fecha, hora_str] = tiempo_str.split('T');
    const hora = parseInt(hora_str.split(':')[0], 10);

    // Valores brutos de cada modelo
    const hs_ibi   = dataIbi.wave_height[i]   ?? null;
    const hs_ecmwf = dataEcmwf.wave_height[i] ?? null;
    const hs_gfs   = dataGfs.wave_height[i]   ?? null;
    const hs_icon  = dataIcon.wave_height[i]  ?? null;

    // Periodo y direccion del modelo IBI (generalmente el mas preciso para la zona)
    const tp_raw  = dataIbi.wave_period    ? (dataIbi.wave_period[i]    ?? null) : null;
    const dir_raw = dataIbi.wave_direction ? (dataIbi.wave_direction[i] ?? null) : null;

    // Si todos los modelos estan a null en esta hora, saltamos
    if (hs_ibi === null && hs_ecmwf === null && hs_gfs === null && hs_icon === null) {
      continue;
    }

    // Calcular prediccion IA
    const hs_ai_raw = usar_media_simple
      ? media_simple(hs_ibi, hs_ecmwf, hs_gfs, hs_icon)
      : aplicar_formula(hs_ibi, hs_ecmwf, hs_gfs, hs_icon, pesos);

    const hs_ai       = r2(hs_ai_raw);
    const quality     = calcular_calidad(hs_ai);
    const dir_cardinal = grados_a_cardinal(dir_raw);

    filas.push({
      forecast_date: fecha,
      forecast_hour: hora,
      hs_ibi:        r2(hs_ibi),
      hs_ecmwf:      r2(hs_ecmwf),
      hs_gfs:        r2(hs_gfs),
      hs_icon:       r2(hs_icon),
      tp_ibi:        r2(tp_raw),
      dir_ibi:       dir_cardinal,
      hs_ai:         hs_ai,
      quality_score: quality,
    });
  }

  console.log(`Filas calculadas: ${filas.length} horas de pronostico.`);

  // Mostrar resumen rapido de los proximos dias
  const hoy     = new Date().toISOString().split('T')[0];
  const de_hoy  = filas.filter(f => f.forecast_date === hoy && f.forecast_hour >= SURF_HOUR_MIN);
  if (de_hoy.length > 0) {
    const hs_max = Math.max(...de_hoy.map(f => f.hs_ai || 0));
    const mejor  = de_hoy.reduce((best, f) => (f.quality_score > (best.quality_score || 0) ? f : best), de_hoy[0]);
    console.log(`\nResumen de HOY (${hoy}):`);
    console.log(`  Hs maxima IA: ${hs_max.toFixed(2)} m`);
    console.log(`  Mejor ventana: ${String(mejor.forecast_hour).padStart(2, '0')}:00h — ${hs_max.toFixed(2)} m — ${mejor.quality_score} estrellas`);
  }

  // 4. Guardar en Supabase
  console.log('\n[4/4] Guardando en Supabase...');
  await guardar_pronostico(filas);

  console.log('\n========================================================');
  console.log(' Oracle completado con exito.');
  console.log(`  Filas guardadas/actualizadas: ${filas.length}`);
  console.log(`  Tabla: forecast_ai`);
  console.log('========================================================\n');
}

// ---------------------------------------------------------------------------
// ARRANQUE
// ---------------------------------------------------------------------------
main().catch(err => {
  console.error('\n[ERROR FATAL]', err.message);
  console.error(err.stack);
  process.exit(1);
});
