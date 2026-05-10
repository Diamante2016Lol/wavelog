export default async function handler(req, res) {
  // 1. Cabeceras para que el navegador no dé problemas
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0');

  const { fecha, hora } = req.query;
  const modoHistorico = fecha && hora;

  try {
    // 2. Llamada a la API oficial con el ID de Barcelona II (1731)
    const response = await fetch('https://portus.puertos.es/portussvr/api/RTData/station/1731?locale=es', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json'
      },
      cache: 'no-store'
    });

    if (!response.ok) throw new Error('Fallo de red');

    const registros = await response.json();
    if (!Array.isArray(registros) || registros.length === 0) throw new Error('Sin datos');

    // 3. Ordenar: El más reciente primero
    registros.sort((a, b) => {
      const ta = new Date(a.fecha.replace(' ', 'T')).getTime();
      const tb = new Date(b.fecha.replace(' ', 'T')).getTime();
      return tb - ta;
    });

    let registroElegido = registros[0]; // Por defecto, el último dato (Widget)

    if (modoHistorico) {
      const target = new Date(`${fecha}T${hora}:00`).getTime();
      let minDiff = Infinity;
      for (const r of registros) {
        const diff = Math.abs(new Date(r.fecha.replace(' ', 'T')).getTime() - target);
        if (diff < minDiff) {
          minDiff = diff;
          registroElegido = r;
        }
      }
    }

    // 4. Mapeo directo de los datos (ID 1=Hs, 2=Hmax, 4=Tp, 6=Dir)
    let dataMap = {};
    registroElegido.datos.forEach(d => { dataMap[d.paramId] = d.valor; });

    const hs = parseFloat(dataMap[1]);
    const hmax = dataMap[2] ? parseFloat(dataMap[2]) : (hs * 1.5);
    const tp = parseFloat(dataMap[4]);
    const dir = parseFloat(dataMap[6]);

    return res.status(200).json({
      hs: hs ? Number(hs.toFixed(2)) : null,
      hmax: hmax ? Number(hmax.toFixed(2)) : null,
      tp: tp ? Number(tp.toFixed(1)) : null,
      dir: gradosACardinal(dir),
      fechaHora: registroElegido.fecha
    });

  } catch (error) {
    // Si falla Puertos del Estado, devolvemos un error claro para el frontend
    return res.status(200).json({ error: true, mensaje: error.message });
  }
}

function gradosACardinal(grados) {
  if (grados === null || isNaN(grados)) return '--';
  const rumbos = ['N', 'NE', 'E', 'SE', 'S', 'SO', 'O', 'NO'];
  const idx = Math.round(((grados % 360) + 360) % 360 / 45) % 8;
  return rumbos[idx];
}
