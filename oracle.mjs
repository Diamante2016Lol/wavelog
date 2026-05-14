
import { createClient } from '@supabase/supabase-js';

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

// ---------------------------------------------------------------------------
// CONSTANTES
// ---------------------------------------------------------------------------
const UMBRAL_IA = 0.8; // metros — por encima: usa IA. Por debajo: media aritmética.

// ---------------------------------------------------------------------------
// Clasificador de ventanas direccionales
// ---------------------------------------------------------------------------
function getVentana(dir) {
  if (dir >= 337.5 || dir < 67.5)  return 'NE';
  if (dir >= 67.5  && dir < 112.5) return 'E';
  if (dir >= 112.5 && dir < 157.5) return 'SE';
  if (dir >= 157.5 && dir < 202.5) return 'S';
  return 'SW'; // 202.5 → 337.5
}

// ---------------------------------------------------------------------------
// Sistema de calidad (0-5 estrellas)
//   Tiene en cuenta altura de ola (hs) Y periodo (tp) para dar estrellas.
//   El orden de las condiciones importa: de mayor a menor exigencia.
// ---------------------------------------------------------------------------
function calcQuality(hs, tp) {
  if (hs < 1.0)                         return 0; // Flat / irrelevante
  if (hs >= 1.8 && tp >= 9.0)           return 5; // Pumping — ola grande y bien organizada
  if (hs >= 1.5 && tp >= 7.5)           return 4; // Muy buenas condiciones
  if (hs >= 1.2 && tp >= 6.5)           return 3; // Sólido y surfeble
  if (hs >= 1.0 && tp >= 6.5)           return 2; // Pequeño pero con periodo decente
  return 1;                                        // >= 1m pero periodo corto/caótico
}

// ---------------------------------------------------------------------------
// MAIN
// ---------------------------------------------------------------------------
async function run() {
  console.log('--- WaveLog Oracle v2: Iniciando (lógica condicional IA + rating mejorado) ---');

  if (!url || !key) {
    console.error('Error: Faltan variables de entorno SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY.');
    process.exit(1);
  }

  const supabase = createClient(url, key, {
    auth:     { persistSession: false },
    realtime: { enabled: false },
  });

  // ── 1. Descarga de pronóstico de Open-Meteo ──────────────────────────────
  console.log('Descargando datos de Open-Meteo...');
  const apiUrl = [
    'https://marine-api.open-meteo.com/v1/marine',
    '?latitude=41.38&longitude=2.15',
    '&hourly=wave_height,wave_period,wave_direction',
    '&models=ecmwf_wam025,ncep_gfswave016,best_match',
    '&forecast_days=3',
  ].join('');

  const res = await fetch(apiUrl);
  if (!res.ok) throw new Error(`Open-Meteo respondió con status ${res.status}`);
  const data = await res.json();
  const h = data.hourly;
  console.log(`Horas recibidas: ${h.time.length}`);

  // ── 2. Cargar pesos de la IA desde Supabase ──────────────────────────────
  console.log('Cargando pesos de la IA...');
  const { data: wData, error: wError } = await supabase
    .from('ai_weights')
    .select('*')
    .order('id', { ascending: false })
    .limit(1);

  if (wError) console.warn('Aviso al cargar pesos:', wError.message);

  // Pesos por defecto si la IA aún no ha sido entrenada con los 4 modelos
  const defaultWeights = { hs_ibi: 0.25, hs_ecmwf: 0.35, hs_gfs: 0.25, hs_icon: 0.15, bias: 0 };
  const pesosPorVentana = wData?.[0]?.weights || {
    NE: defaultWeights, E: defaultWeights, SE: defaultWeights,
    S:  defaultWeights, SW: defaultWeights,
  };

  const modeloId  = wData?.[0]?.id         || 'default';
  const muestras  = wData?.[0]?.training_samples || '—';
  console.log(`Modelo IA activo: #${modeloId} (${muestras} muestras de entrenamiento)`);

  // ── 3. Procesar cada hora ─────────────────────────────────────────────────
  console.log('Procesando horas...');
  let horasConIA = 0;
  let horasConMedia = 0;

  const filas = h.time.map((t, i) => {
    // Valores brutos de cada modelo (0 si no disponible)
    // NOTA: Actualmente best_match actúa como proxy de IBI e ICON.
    //       Cuando se añadan esos modelos a la API, sustituir por sus variables reales.
    const ibi  = h.wave_height_best_match?.[i]        || 0;
    const ecmwf = h.wave_height_ecmwf_wam025?.[i]     || 0;
    const gfs   = h.wave_height_ncep_gfswave016?.[i]  || 0;
    const icon  = h.wave_height_best_match?.[i]        || 0; // mismo proxy por ahora

    const tp  = h.wave_period_ecmwf_wam025?.[i]       || 0;
    const dir = h.wave_direction_ecmwf_wam025?.[i]    || 180;

    // Ventana direccional y sus multiplicadores
    const ventana = getVentana(dir);
    const conf    = pesosPorVentana[ventana] || defaultWeights;

    // ── LÓGICA CONDICIONAL DE HS_FINAL ──────────────────────────────────────
    const modelosBrutos = [ibi, ecmwf, gfs, icon];
    const algunoSuperaUmbral = modelosBrutos.some(v => v > UMBRAL_IA);

    let hs_final;
    let metodo;

    if (algunoSuperaUmbral) {
      // ✅ Al menos un modelo supera 0.8m → aplica fórmula IA con pesos y bias
      hs_final =
        (ibi   * (conf.hs_ibi   || 0)) +
        (ecmwf * (conf.hs_ecmwf || 0)) +
        (gfs   * (conf.hs_gfs   || 0)) +
        (icon  * (conf.hs_icon  || 0)) +
        (conf.bias || 0);
      metodo = 'AI';
      horasConIA++;
    } else {
      // ⚡ Ningún modelo supera 0.8m → media aritmética de los modelos con valor > 0
      //    Evita distorsionar el promedio con ceros de modelos sin dato.
      const valoresValidos = modelosBrutos.filter(v => v > 0);
      hs_final = valoresValidos.length > 0
        ? valoresValidos.reduce((acc, v) => acc + v, 0) / valoresValidos.length
        : 0;
      metodo = 'AVG';
      horasConMedia++;
    }

    // Nunca negativo
    const hs_clamped = Math.max(0, hs_final);

    // Calidad con la nueva escala 0-5 (hs + periodo)
    const quality_score = calcQuality(hs_clamped, tp);

    return {
      timestamp:     t,
      forecast_date: t.split('T')[0],
      forecast_hour: parseInt(t.split('T')[1]),
      hs_ai:         parseFloat(hs_clamped.toFixed(3)),
      tp_ai:         tp,
      dir_ai:        dir,
      ibi_hs:        ibi,
      ecmwf_hs:      ecmwf,
      gfs_hs:        gfs,
      icon_hs:       icon,
      quality_score,
      // Auditoría: guarda qué método se usó en cada hora
      model_data: {
        ventana,
        metodo,           // 'AI' | 'AVG'
        umbral_activo:    UMBRAL_IA,
        modelo_ia_id:     modeloId,
        pesos_aplicados: metodo === 'AI' ? conf : null,
      },
    };
  });

  console.log(`Resumen procesamiento: ${horasConIA} horas con IA | ${horasConMedia} horas con media aritmética`);

  // ── 4. Guardar en Supabase ────────────────────────────────────────────────
  console.log('Guardando pronóstico en Supabase...');
  const { error: upsertError } = await supabase
    .from('forecast_ai')
    .upsert(filas, { onConflict: 'timestamp' });

  if (upsertError) throw upsertError;

  console.log(`✅ ${filas.length} horas guardadas correctamente en forecast_ai.`);
  console.log('--- WaveLog Oracle v2: Finalizado ---');
}

run().catch(e => {
  console.error('❌ Fallo crítico del Oracle:', e.message);
  process.exit(1);
});
