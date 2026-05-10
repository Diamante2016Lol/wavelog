export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const { fecha, hora } = req.query;
  const modoHistorico = fecha && hora;

  let hs = null, hmax = null, tp = null, dirGrados = null, fechaHora = null;
  let diferenciaMinutos = 0;
  let fuente = 'desconocida';

  try {
    // 1. PUERTOS DEL ESTADO - Extracción Quirúrgica basada en la tabla oficial
    const urlPdE = 'https://portus.puertos.es/portussvr/api/RTData/station/1731?locale=es';
    const responsePdE = await fetch(urlPdE, {
        headers: {
            'Accept': 'application/json',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36'
        },
        cache: 'no-store'
    });

    if (responsePdE.ok) {
      const rawData = await responsePdE.json();
      let registros = Array.isArray(rawData) ? rawData : [];

      // Convertir la fecha "2026-05-10 18:00:00.0" a formato absoluto UTC ("Z") 
      // y ordenar de más reciente a más antiguo
      registros = registros.map(reg => {
         let f = reg.fecha || "";
         f = f.replace(' ', 'T').replace('.0', '') + 'Z'; 
         return { ...reg, timestamp: new Date(f).getTime(), fechaISO: f };
      }).filter(r => !isNaN(r.timestamp)).sort((a, b) => b.timestamp - a.timestamp);

      // Lector estricto de identificadores (Hs=1, Hmax=2, Tp=4, Dir=6)
      const leerDatos = (datosArray) => {
          let encontro = false;
          if (Array.isArray(datosArray)) {
              for (const d of datosArray) {
                  const id = Number(d.paramId);
                  const val = Number(d.valor);
                  if (!isNaN(val)) {
                      if (id === 1) { hs = val; encontro = true; }
                      if (id === 2) { hmax = val; }
                      if (id === 4) { tp = val; }
                      if (id === 6) { dirGrados = val; }
                  }
              }
          }
          return encontro;
      };

      if (modoHistorico) {
         // Transformar la hora del formulario (España, asumiendo verano +02:00) a Timestamp para buscar exacto
         const targetTimestamp = new Date(`${fecha}T${hora}:00+02:00`).getTime();
         let minDiff = Infinity;
         let mejorRegistro = null;

         for (const reg of registros) {
             const diff = Math.abs(reg.timestamp - targetTimestamp);
             // Verificar si este bloque horario tiene datos de Hs (paramId=1)
             const tieneHs = Array.isArray(reg.datos) && reg.datos.some(d => Number(d.paramId) === 1);
             
             if (tieneHs && diff < minDiff) {
                 minDiff = diff;
                 mejorRegistro = reg;
             }
         }

         if (mejorRegistro) {
             leerDatos(mejorRegistro.datos);
             fechaHora = mejorRegistro.fechaISO;
             diferenciaMinutos = Math.round(minDiff / 60000);
             fuente = 'historico_puertos';
         }
      } else {
         // MODO LIVE: Busca el primer bloque disponible que tenga olas.
         // Esto respeta el retraso natural de 1 o 2 horas de la boya real.
         for (const reg of registros) {
             if (leerDatos(reg.datos)) {
                 fechaHora = reg.fechaISO;
                 fuente = 'live_puertos';
                 break;
             }
         }
      }
    }
  } catch (e) {
    console.warn("Fallo Puertos del Estado:", e.message);
  }

  // 2. RED DE SEGURIDAD OPEN-METEO
  if (hs === null && tp === null) {
    try {
        const lat = 41.38, lon = 2.17;
        if (modoHistorico) {
            const omUrl = `https://marine-api.open-meteo.com/v1/marine?latitude=${lat}&longitude=${lon}&hourly=wave_height,wave_period,wave_direction&timezone=Europe/Madrid&start_date=${fecha}&end_date=${fecha}`;
            const omRes = await fetch(omUrl);
            if (omRes.ok) {
                const data = await omRes.json();
                if (data.hourly && data.hourly.time && data.hourly.time.length > 0) {
                    const targetTimestamp = new Date(`${fecha}T${hora}:00+02:00`).getTime();
                    let bestIdx = 0, minDiff = Infinity;
                    data.hourly.time.forEach((timeStr, i) => {
                        const diff = Math.abs(new Date(timeStr).getTime() - targetTimestamp);
                        if (diff < minDiff) { minDiff = diff; bestIdx = i; }
                    });
                    hs = data.hourly.wave_height[bestIdx];
                    tp = data.hourly.wave_period[bestIdx];
                    dirGrados = data.hourly.wave_direction[bestIdx];
                    hmax = hs !== null ? parseFloat((hs * 1.5).toFixed(2)) : null;
                    fechaHora = data.hourly.time[bestIdx];
                    diferenciaMinutos = Math.round(minDiff / 60000);
                    fuente = 'historico_openmeteo';
                }
            }
        } else {
            const omUrl = `https://marine-api.open-meteo.com/v1/marine?latitude=${lat}&longitude=${lon}&current=wave_height,wave_period,wave_direction&timezone=Europe/Madrid`;
            const omRes = await fetch(omUrl);
            if (omRes.ok) {
                const omData = await omRes.json();
                hs = omData.current.wave_height;
                tp = omData.current.wave_period;
                dirGrados = omData.current.wave_direction;
                hmax = hs ? hs * 1.5 : null;
                fechaHora = omData.current.time;
                fuente = 'live_openmeteo';
            }
        }
    } catch (e) {
        console.warn("Fallo Open-Meteo:", e.message);
    }
  }

  if (hs === null && tp === null) {
      return res.status(404).json({ error: 'No se encontraron datos.' });
  }

  return res.status(200).json({
    modo: fuente,
    hs: hs !== null ? parseFloat(hs.toFixed(2)) : null,
    hmax: hmax !== null ? parseFloat(hmax.toFixed(2)) : null,
    tp: tp !== null ? parseFloat(tp.toFixed(1)) : null,
    dir: gradosACardinal(dirGrados),
    diferenciaMinutos: Math.abs(diferenciaMinutos),
    fechaHora: fechaHora || new Date().toISOString()
  });
}

function gradosACardinal(grados) {
  if (grados === null || isNaN(grados)) return '--';
  const rumbos = ['N', 'NE', 'E', 'SE', 'S', 'SO', 'O', 'NO'];
  let calc = grados / 360;
  let normalized = (calc - Math.floor(calc)) * 360;
  let idx = Math.round(normalized / 45);
  if (idx === 8) idx = 0;
  return rumbos[idx];
}
