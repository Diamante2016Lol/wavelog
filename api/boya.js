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
    // 1. INTENTAR PUERTOS DEL ESTADO (RTData)
    const urlPdE = 'https://portus.puertos.es/portussvr/api/RTData/station/1731?locale=es';
    const responsePdE = await fetch(urlPdE, { 
        headers: { 
            'Accept': 'application/json',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
        },
        cache: 'no-store' // <- MAGIA 1: Evita que Vercel congele los datos antiguos
    });
    
    if (responsePdE.ok) {
      const rawData = await responsePdE.json();
      const listaRegistros = Array.isArray(rawData) ? rawData : [rawData];
      
      // Ordenamos de más reciente a más antiguo
      listaRegistros.sort((a, b) => {
        const timeA = new Date(a.fecha || a.date || a.dateTime || 0).getTime();
        const timeB = new Date(b.fecha || b.date || b.dateTime || 0).getTime();
        return timeB - timeA;
      });

      function extraerDatos(reg) {
        let encontradoOlas = false;
        const listaDatos = reg.datos || reg.measurements || reg.data || (Array.isArray(reg) ? reg : []);
        
        for (const item of listaDatos) {
           let val = null;
           let keywords = "";

           // MAGIA 2: Escáner bruto que ignora la estructura exacta del Gobierno
           if (typeof item === 'object') {
               for (let key in item) {
                   const k = key.toLowerCase();
                   const v = item[key];
                   if (k.includes('valor') || k.includes('value') || k === 'v' || k === 'dato' || k === 'val') {
                       val = v;
                   } else {
                       keywords += " " + String(v).toLowerCase() + " " + k + " ";
                   }
               }
           }
           
           if (val !== null && val !== undefined) {
               const num = parseFloat(String(val).replace(',', '.'));
               
               if (keywords.includes(' 1 ') || keywords.includes(' 32 ') || keywords.includes('sig') || keywords.includes('hs')) { hs = num; encontradoOlas = true; }
               else if (keywords.includes(' 2 ') || keywords.includes(' 33 ') || keywords.includes('max') || keywords.includes('máx')) { hmax = num; }
               else if (keywords.includes(' 4 ') || keywords.includes(' 34 ') || keywords.includes('pic') || keywords.includes('tp')) { tp = num; }
               else if (keywords.includes(' 6 ') || keywords.includes(' 36 ') || keywords.includes('dir') || keywords.includes('proc')) { dirGrados = num; }
           }
        }

        if (encontradoOlas) {
           let f = reg.fecha || reg.date || reg.dateTime || "";
           // MAGIA 3: Forzar conversión a zona horaria de España
           if (f && !f.includes('Z') && !f.includes('+')) f = f.trim() + 'Z';
           fechaHora = f;
        }
        return encontradoOlas;
      }

      if (modoHistorico) {
        const targetTimestamp = new Date(`${fecha}T${hora}:00Z`).getTime(); 
        let minDiff = Infinity;
        let registroElegido = null;

        for (const reg of listaRegistros) {
          let regTimeStr = reg.fecha || reg.date || reg.dateTime || "";
          if (regTimeStr && !regTimeStr.includes('Z') && !regTimeStr.includes('+')) regTimeStr += 'Z';
          const regTime = new Date(regTimeStr).getTime();
          
          const diff = Math.abs(regTime - targetTimestamp);
          
          if (diff < minDiff) {
            let tieneOlas = false;
            const datos = reg.datos || reg.measurements || reg.data || (Array.isArray(reg) ? reg : []);
            for (const d of datos) {
                let keys = JSON.stringify(d).toLowerCase();
                if (keys.includes('sig') || keys.includes('hs') || keys.includes('"1"') || keys.includes(':1,') || keys.includes('paramid":1')) {
                    tieneOlas = true;
                }
            }
            if (tieneOlas) {
                minDiff = diff;
                registroElegido = reg;
                diferenciaMinutos = Math.round(diff / 60000);
            }
          }
        }
        
        if (registroElegido && diferenciaMinutos <= 1440) { 
           extraerDatos(registroElegido);
           fuente = 'historico_puertos';
        }
      } else {
        for (const reg of listaRegistros) {
           if (extraerDatos(reg)) {
               fuente = 'live_puertos';
               break; 
           }
        }
      }
    }
  } catch (e) {
    console.warn("Fallo en Puertos del Estado:", e.message);
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
