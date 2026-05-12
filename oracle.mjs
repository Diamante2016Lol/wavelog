import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const LAT = 41.38;
const LON = 2.15;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

async function ejecutarOraculo() {
  console.log('Iniciando WaveLog Oracle...');

  // 1. DESCARGAR DATOS
  // Usamos los nombres tecnicos exactos que acepta la API de Open-Meteo
  console.log('Pidiendo datos a Open-Meteo...');
  const modelosString = "ecmwf_wam025,ncep_gfswave016,best_match";
  const api_url = `https://marine-api.open-meteo.com/v1/marine?latitude=${LAT}&longitude=${LON}&hourly=wave_height,wave_period,wave_direction&models=${modelosString}&forecast_days=3`;

  const respuesta = await fetch(api_url);
  if (!respuesta.ok) {
    const textoError = await respuesta.text();
    throw new Error('Error en Open-Meteo: ' + textoError);
  }
  
  const datosMeteo = await respuesta.json();
  const h = datosMeteo.hourly;

  // 2. BUSCAR PESOS DE LA IA EN SUPABASE
  console.log('Buscando configuracion de la IA...');
  const { data: listadoPesos, error: errorPesos } = await supabase
    .from('ai_weights')
    .select('weights, bias')
    .order('created_at', { ascending: false })
    .limit(1);

  let w = { hs_ibi: 0, hs_ecmwf: 0.5, hs_gfs: 0.5, hs_icon: 0 };
  let sesgoIA = 0;

  if (errorPesos || !listadoPesos || listadoPesos.length === 0) {
    console.log('Aviso: Usando configuracion por defecto (50-50 ECMWF/GFS)');
  } else {
    w = listadoPesos[0].weights;
    sesgoIA = listadoPesos[0].bias || 0;
    console.log('Pesos cargados con exito.');
  }

  // 3. CALCULAR PREDICCION
  console.log('Calculando pronostico inteligente...');
  const predicciones = h.time.map((tiempo, indice) => {
    
    // Extraemos la altura de los modelos (con seguridad por si alguno falta)
    const valor_ecmwf = h.wave_height_ecmwf_wam025 ? h.wave_height_ecmwf_wam025[indice] : (h.wave_height[indice] || 0);
    const valor_gfs   = h.wave_height_ncep_gfswave016 ? h.wave_height_ncep_gfswave016[indice] : (h.wave_height[indice] || 0);
    
    // Aplicamos la formula entrenada
    // Nota: hs_ibi y hs_icon seran multiplicados por 0 si entrenaste con el metodo Bimotor
    let calculo_hs = (valor_ecmwf * (w.hs_ecmwf || 0)) + (valor_gfs * (w.hs_gfs || 0)) + sesgoIA;

    return {
      timestamp: tiempo,
      forecast_date: tiempo.split('T')[0],
      forecast_hour: parseInt(tiempo.split('T')[1].split(':')[0]),
      hs_ai: Math.max(0.1, calculo_hs), 
      ibi_hs: 0,
      ecmwf_hs: valor_ecmwf,
      gfs_hs: valor_gfs,
      icon_hs: 0,
      tp_ai: h.wave_period ? h.wave_period[indice] : 8,
      dir_ai: h.wave_direction ? h.wave_direction[indice] : 180
    };
  });

  // 4. GUARDAR EN SUPABASE
  console.log('Guardando resultados en la tabla forecast_ai...');
  const { error: errorGuardado } = await supabase
    .from('forecast_ai')
    .upsert(predicciones, { onConflict: 'timestamp' });

  if (errorGuardado) throw errorGuardado;
  
  console.log('Proceso finalizado con exito.');
}

ejecutarOraculo().catch(err => {
  console.error('Fallo en el Oraculo:', err.message);
  process.exit(1);
});
