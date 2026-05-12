import { createClient } from '@supabase/supabase-js';

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY; 

async function ejecutarOraculo() {
  console.log('--- WaveLog Oracle: Iniciando (Versión Blindada) ---');
  
  if (!url || !key) {
    console.error('❌ ERROR: Faltan las llaves de Supabase en los secretos de GitHub.');
    process.exit(1);
  }

  const supabase = createClient(url, key, {
    auth: { persistSession: false },
    realtime: { enabled: false } 
  });

  // 1. DESCARGA DE DATOS
  console.log('Consultando Open-Meteo...');
  const modelos = "ecmwf_wam025,ncep_gfswave016";
  const api_url = `https://marine-api.open-meteo.com/v1/marine?latitude=41.38&longitude=2.15&hourly=wave_height,wave_period,wave_direction&models=${modelos}&forecast_days=3`;

  const res = await fetch(api_url);
  const data = await res.json();

  if (!res.ok || !data.hourly) {
    console.error('❌ ERROR API:', data.reason || 'Respuesta de Open-Meteo sin datos horarios.');
    process.exit(1);
  }

  const h = data.hourly;

  // 2. CARGAR PESOS DE IA
  console.log('Buscando pesos en Supabase...');
  const { data: wData, error: wError } = await supabase
    .from('ai_weights')
    .select('*')
    .order('id', { ascending: false })
    .limit(1);

  // Definimos valores por defecto seguros
  let w = { hs_ecmwf: 0.5, hs_gfs: 0.5 };
  let bias = 0;

  if (wError) {
    console.warn('⚠️ Aviso: Error al conectar con ai_weights:', wError.message);
  } else if (!wData || wData.length === 0) {
    console.warn('⚠️ Aviso: No hay pesos entrenados. Usando configuración 50/50.');
  } else {
    // Usamos el operador ?. para que si 'weights' no existe, no explote
    w = wData[0]?.weights || w;
    bias = wData[0]?.bias || 0;
    console.log('✅ Pesos cargados correctamente.');
  }

  // 3. CALCULAR PREDICCIÓN
  console.log('Calculando pronóstico para las próximas 72 horas...');
  
  // Verificamos que h.time existe antes de mapear
  if (!h.time || !Array.isArray(h.time)) {
    throw new Error('Open-Meteo no devolvió la lista de horas (h.time).');
  }

  const predicciones = h.time.map((t, i) => {
    // Leemos los modelos con seguridad total
    const e = (h.wave_height_ecmwf_wam025 && h.wave_height_ecmwf_wam025[i]) || 0;
    const g = (h.wave_height_ncep_gfswave016 && h.wave_height_ncep_gfswave016[i]) || 0;
    
    // Cálculo de la IA
    const hs_ai = (e * (w.hs_ecmwf || 0)) + (g * (w.hs_gfs || 0)) + bias;

    // Extraemos fecha y hora con seguridad
    const partes = t.split('T');
    const fecha = partes[0] || '2026-01-01';
    const horaTexto = partes[1] ? partes[1].split(':')[0] : '0';
    const hora = parseInt(horaTexto);

    return {
      timestamp: t,
      forecast_date: fecha,
      forecast_hour: hora,
      hs_ai: Math.max(0.1, hs_ai),
      ibi_hs: 0,
      ecmwf_hs: e,
      gfs_hs: g,
      icon_hs: 0,
      tp_ai: (h.wave_period && h.wave_period[i]) || 8,
      dir_ai: (h.wave_direction && h.wave_direction[i]) || 180
    };
  });

  // 4. GUARDAR EN SUPABASE
  console.log(`Subiendo ${predicciones.length} filas a forecast_ai...`);
  const { error: upsertError } = await supabase
    .from('forecast_ai')
    .upsert(predicciones, { onConflict: 'timestamp' });

  if (upsertError) {
    console.error('❌ ERROR al guardar en Supabase:', upsertError.message);
    process.exit(1);
  }

  console.log('🚀 ¡PROCESO COMPLETADO CON ÉXITO!');
}

ejecutarOraculo().catch(err => {
  console.error('💥 FALLO CRÍTICO INESPERADO:', err.message);
  process.exit(1);
});
