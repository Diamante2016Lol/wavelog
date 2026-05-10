// api/boya.js — Proxy para la Boya de Barcelona (Estacion 12) de Puertos del Estado
// Desplegado como Serverless Function en Vercel
// Acepta query params: ?fecha=YYYYMMDD&hora=HH:MM
// Sin params devuelve el ultimo dato en tiempo real.

// api/boya.js — Proxy Híbrido: Boya Oficial (Live) + Open-Meteo (Histórico)
// Desplegado en Vercel.

// api/boya.js — Proxy Blindado Vercel
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
    // 1. INTENTAR PUERTOS DEL ESTADO (RTData tiene el historial reciente)
    const urlPdE = 'https://portus.puertos.es/portussvr/api/RTData/station/1731?locale=es';
    const responsePdE = await fetch(urlPdE, { headers: { 'Accept': 'application/json' } });
    
    if (responsePdE.ok) {
      const rawData = await responsePdE.json();
      const listaRegistros = Array.isArray(rawData) ? rawData : [rawData];
      
      let registroElegido = null;

      if (modoHistorico) {
        // Buscar la hora exacta dentro de la tabla oficial del Gobierno
        const targetTimestamp = new Date(`${fecha}T${hora}`).getTime();
        let minDiff = Infinity;

        for (const reg of listaRegistros) {
          const regTime = new Date(reg.fecha || reg.date || reg.dateTime).getTime();
          const diff = Math.abs(regTime - targetTimestamp);
          if (diff < minDiff) {
            minDiff = diff;
            registroElegido = reg;
            diferenciaMinutos = Math.round(diff / 60000);
          }
        }
        
        // Si pedimos un dato de hace semanas, RTData no lo tendra. Lo pasamos al Plan B.
        if (diferenciaMinutos > 1440) {
           registroElegido = null; 
        }
      } else {
        // Modo live: el primer dato de la tabla
        registroElegido = listaRegistros[0];
      }

      if (registroElegido) {
        fechaHora = registroElegido.fecha || registroElegido.date || registroElegido.dateTime;
        const listaDatos = registroElegido.datos || registroElegido.measurements || registroElegido.data || (Array.isArray(registroElegido) ? registroElegido : []);

        for (const item of listaDatos) {
          const val = item.valor ?? item.value ?? item.v ?? item.dato;
          if (val !== undefined && val !== null) {
            const id = String(item.paramId || item.idVariable || item.id || "");
            const name = String(item.nombre || item.param || item.variable || item.description || "").toLowerCase();

            if (id === "1" || id === "32" || name.includes("hs") || name.includes("sig")) hs = parseFloat(val);
            else if (id === "2" || id === "33" || name.includes("max") || name.includes("máx")) hmax = parseFloat(val);
            else if (id === "4" || id === "34" || name.includes("tp") || name.includes("pic")) tp = parseFloat(val);
            else if (id === "6" || id === "36" || name.includes("dir") || name.includes("proc")) dirGrados = parseFloat(val);
          }
        }
        if (hs !== null || tp !== null) {
            fuente = modoHistorico ? 'historico_puertos' : 'live_puertos';
        }
      }
    }
  } catch (e) {
    console.warn("Fallo en Puertos del Estado:", e.message);
  }

  // 2. RED DE SEGURIDAD: OPEN-METEO (Para baños de hace meses)
  if (hs === null && tp === null) {
    try {
        const lat = 41.38, lon = 2.17;
        if (modoHistorico) {
            const omUrl = `https://marine-api.open-meteo.com/v1/marine?latitude=${lat}&longitude=${lon}&hourly=wave_height,wave_period,wave_direction&timezone=Europe/Madrid&start_date=${fecha}&end_date=${fecha}`;
            const omRes = await fetch(omUrl);
            if (omRes.ok) {
                const data = await omRes.json();
                if (data.hourly && data.hourly.time && data.hourly.time.length > 0) {
                    const targetTimestamp = new Date(`${fecha}T${hora}`).getTime();
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
        console.warn("Fallo en Open-Meteo:", e.message);
    }
  }

  // 3. RESPUESTA FINAL
  if (hs === null && tp === null) {
      return res.status(404).json({ error: 'No se encontraron datos en ninguna fuente.' });
  }

  return res.status(200).json({
    modo: fuente,
    hs: hs !== null ? parseFloat(hs.toFixed(2)) : null,
    hmax: hmax !== null ? parseFloat(hmax.toFixed(2)) : null,
    tp: tp !== null ? parseFloat(tp.toFixed(1)) : null,
    dir: gradosACardinal(dirGrados),
    diferenciaMinutos: diferenciaMinutos,
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
