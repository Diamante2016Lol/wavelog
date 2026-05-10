export default async function handler(req, res) {
  // DESTRUCTOR DE CACHÉ: Obliga a Vercel y al navegador a pedir datos nuevos siempre
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  res.setHeader('Pragma', 'no-cache');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const { fecha, hora } = req.query;
  const modoHistorico = fecha && hora;

  try {
    const response = await fetch('https://portus.puertos.es/portussvr/api/RTData/station/1731?locale=es', {
        headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' },
        cache: 'no-store' // Evita que la petición interna se quede pillada
    });

    if (!response.ok) throw new Error('Bloqueado por Puertos del Estado');

    const rawData = await response.json();
    let registros = Array.isArray(rawData) ? rawData : [];

    // Ordenamos estrictamente de más reciente a más antiguo
    registros.sort((a, b) => {
        const ta = new Date(a.fecha ? a.fecha.replace(' ', 'T').replace('.0', '') + 'Z' : 0).getTime();
        const tb = new Date(b.fecha ? b.fecha.replace(' ', 'T').replace('.0', '') + 'Z' : 0).getTime();
        return tb - ta;
    });

    let hs = null, hmax = null, tp = null, dirGrados = null, fechaFinal = null;

    const procesarBloque = (datos) => {
        let hayOlas = false;
        if (Array.isArray(datos)) {
            for (const d of datos) {
                const id = Number(d.paramId);
                const val = Number(d.valor);
                if (!isNaN(val)) {
                    if (id === 1) { hs = val; hayOlas = true; }
                    else if (id === 2) { hmax = val; }
                    else if (id === 4) { tp = val; }
                    else if (id === 6) { dirGrados = val; }
                }
            }
        }
        return hayOlas;
    };

    if (modoHistorico) {
        // Convertimos la hora de España al reloj absoluto
        const targetTime = new Date(`${fecha}T${hora}:00+02:00`).getTime();
        let menorDiferencia = Infinity;
        let registroSeleccionado = null;

        for (const reg of registros) {
            if (!reg.fecha) continue;
            const t = new Date(reg.fecha.replace(' ', 'T').replace('.0', '') + 'Z').getTime();
            const diff = Math.abs(t - targetTime);

            const tieneOlas = Array.isArray(reg.datos) && reg.datos.some(d => Number(d.paramId) === 1);
            if (tieneOlas && diff < menorDiferencia) {
                menorDiferencia = diff;
                registroSeleccionado = reg;
            }
        }

        if (registroSeleccionado && menorDiferencia <= 86400000) { 
            procesarBloque(registroSeleccionado.datos);
            fechaFinal = registroSeleccionado.fecha;
        } else {
            throw new Error('Sin histórico reciente, pasa a Open-Meteo');
        }
    } else {
        // MODO LIVE: Busca la medición más fresca que tenga olas (respeta el retraso de la boya)
        for (const reg of registros) {
            if (procesarBloque(reg.datos)) {
                fechaFinal = reg.fecha;
                break;
            }
        }
    }

    if (hs !== null) {
        return res.status(200).json({
            modo: modoHistorico ? 'historico_puertos' : 'live_puertos',
            hs: Number(hs.toFixed(2)),
            hmax: hmax !== null ? Number(hmax.toFixed(2)) : null,
            tp: tp !== null ? Number(tp.toFixed(1)) : null,
            dir: gradosACardinal(dirGrados),
            fechaHora: fechaFinal
        });
    }
    throw new Error('No se encontraron olas en Puertos');

  } catch (error) {
      // PLAN DE RESCATE: Open-Meteo
      const lat = 41.38, lon = 2.17;
      let hsOM = null, hmaxOM = null, tpOM = null, dirOM = null, fechaOM = null;

      if (modoHistorico) {
          const resOM = await fetch(`https://marine-api.open-meteo.com/v1/marine?latitude=${lat}&longitude=${lon}&hourly=wave_height,wave_period,wave_direction&timezone=Europe/Madrid&start_date=${fecha}&end_date=${fecha}`);
          const dataOM = await resOM.json();
          
          if (dataOM.hourly && dataOM.hourly.time.length > 0) {
              const target = new Date(`${fecha}T${hora}:00+02:00`).getTime();
              let minDiff = Infinity;
              let idx = 0;
              dataOM.hourly.time.forEach((tStr, i) => {
                  const diff = Math.abs(new Date(tStr).getTime() - target);
                  if (diff < minDiff) { minDiff = diff; idx = i; }
              });
              hsOM = dataOM.hourly.wave_height[idx];
              tpOM = dataOM.hourly.wave_period[idx];
              dirOM = dataOM.hourly.wave_direction[idx];
              hmaxOM = hsOM ? hsOM * 1.5 : null;
              fechaOM = dataOM.hourly.time[idx];
          }
      } else {
          const resOM = await fetch(`https://marine-api.open-meteo.com/v1/marine?latitude=${lat}&longitude=${lon}&current=wave_height,wave_period,wave_direction&timezone=Europe/Madrid`);
          const dataOM = await resOM.json();
          hsOM = dataOM.current.wave_height;
          tpOM = dataOM.current.wave_period;
          dirOM = dataOM.current.wave_direction;
          hmaxOM = hsOM ? hsOM * 1.5 : null;
          fechaOM = dataOM.current.time;
      }

      return res.status(200).json({
          modo: 'openmeteo',
          hs: hsOM ? Number(hsOM.toFixed(2)) : null,
          hmax: hmaxOM ? Number(hmaxOM.toFixed(2)) : null,
          tp: tpOM ? Number(tpOM.toFixed(1)) : null,
          dir: dirOM !== null ? gradosACardinal(dirOM) : '--',
          fechaHora: fechaOM
      });
  }
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
