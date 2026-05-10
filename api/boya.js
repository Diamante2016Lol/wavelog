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
    // 1. INTENTAR PUERTOS DEL ESTADO
    const urlPdE = 'https://portus.puertos.es/portussvr/api/RTData/station/1731?locale=es';
    const responsePdE = await fetch(urlPdE, { headers: { 'Accept': 'application/json' } });
    
    if (responsePdE.ok) {
      const rawData = await responsePdE.json();
      const listaRegistros = Array.isArray(rawData) ? rawData : [rawData];
      
      // SOLUCION: Ordenamos los datos de más reciente a más antiguo
      listaRegistros.sort((a, b) => {
        const timeA = new Date(a.fecha || a.date || a.dateTime || 0).getTime();
        const timeB = new Date(b.fecha || b.date || b.dateTime || 0).getTime();
        return timeB - timeA;
      });

      // Función interna para extraer datos sin repetir código
      function extraerDatos(reg) {
        let encontradoOlas = false;
        const listaDatos = reg.datos || reg.measurements || reg.data || (Array.isArray(reg) ? reg : []);
        for (const item of listaDatos) {
          const val = item.valor ?? item.value ?? item.v ?? item.dato;
          if (val !== undefined && val !== null) {
            const id = String(item.paramId || item.idVariable || item.id || "");
            const name = String(item.nombre || item.param || item.variable || item.description || "").toLowerCase();

            if (id === "1" || id === "32" || name.includes("hs") || name.includes("sig")) { hs = parseFloat(val); encontradoOlas = true; }
            else if (id === "2" || id === "33" || name.includes("max") || name.includes("máx")) { hmax = parseFloat(val); }
            else if (id === "4" || id === "34" || name.includes("tp") || name.includes("pic")) { tp = parseFloat(val); }
            else if (id === "6" || id === "36" || name.includes("dir") || name.includes("proc")) { dirGrados = parseFloat(val); }
          }
        }
        if (encontradoOlas) {
          fechaHora = reg.fecha || reg.date || reg.dateTime;
        }
        return encontradoOlas;
      }

      if (modoHistorico) {
        const targetTimestamp = new Date(`${fecha}T${hora}`).getTime();
        let minDiff = Infinity;
        let registroElegido = null;

        // Buscar la hora más cercana en la tabla oficial
        for (const reg of listaRegistros) {
          const regTime = new Date(reg.fecha || reg.date || reg.dateTime).getTime();
          const diff = Math.abs(regTime - targetTimestamp);
          
          if (diff < minDiff) {
            // Verificar si este bloque tiene datos de oleaje (Hs) antes de seleccionarlo
            let tieneOlas = false;
            const datos = reg.datos || reg.measurements || reg.data || (Array.isArray(reg) ? reg : []);
            for (const d of datos) {
               const id = String(d.paramId || d.idVariable || d.id || "");
               if (id === "1" || id === "32") tieneOlas = true;
            }
            if (tieneOlas) {
                minDiff = diff;
                registroElegido = reg;
                diferenciaMinutos = Math.round(diff / 60000);
            }
          }
        }
        
        if (registroElegido && diferenciaMinutos <= 1440) { // Max 24h de diferencia
           extraerDatos(registroElegido);
           fuente = 'historico_puertos';
        }
      } else {
        // Modo Live: buscar el primer registro (ahora el más nuevo) que tenga datos de oleaje
        for (const reg of listaRegistros) {
           if (extraerDatos(reg)) {
               fuente = 'live_puertos';
               break; // Detenerse en el primero válido encontrado
           }
        }
      }
    }
  } catch (e) {
    console.warn("Fallo en Puertos del Estado:", e.message);
  }

  // 2. RED DE SEGURIDAD OPEN-METEO (Si fallan los puertos o el historial es muy antiguo)
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

  // 3. RESULTADO FINAL
  if (hs === null && tp === null) {
      return res.status(404).json({ error: 'No se encontraron datos.' });
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
