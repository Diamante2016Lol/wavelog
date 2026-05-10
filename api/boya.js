export default async function handler(req, res) {
  // Cabeceras de seguridad y control de cache
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const { fecha, hora } = req.query;
  const modoHistorico = fecha && hora;

  try {
    // Añadimos un timestamp unico a la URL para saltarnos cualquier cache
    const timestamp = Date.now();
    const url = `https://portus.puertos.es/portussvr/api/RTData/station/1731?locale=es&t=${timestamp}`;

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'Accept-Language': 'es-ES,es;q=0.9',
        'Connection': 'keep-alive',
        'Referer': 'https://portus.puertos.es/',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
      },
      cache: 'no-store'
    });

    if (!response.ok) throw new Error('Error de conexion con el servidor oficial');

    const registros = await response.json();
    if (!Array.isArray(registros) || registros.length === 0) throw new Error('No hay datos disponibles');

    // Función para convertir la fecha del Gobierno a formato JS limpio
    const parseDate = (f) => new Date(f.replace(' ', 'T').replace('.0', '') + 'Z').getTime();

    // Ordenar de mas reciente a mas antiguo
    registros.sort((a, b) => parseDate(b.fecha) - parseDate(a.fecha));

    let bloqueElegido = registros[0];

    if (modoHistorico) {
      // Ajustamos la hora solicitada a horario UTC para comparar
      const target = new Date(`${fecha}T${hora}:00Z`).getTime();
      let minDiff = Infinity;
      for (const reg of registros) {
        const diff = Math.abs(parseDate(reg.fecha) - target);
        if (diff < minDiff) {
          minDiff = diff;
          bloqueElegido = reg;
        }
      }
    }

    // Extraer variables por su ID oficial (1=Hs, 2=Hmax, 4=Tp, 6=Dir)
    let hs = null, hmax = null, tp = null, dir = null;
    
    if (bloqueElegido && bloqueElegido.datos) {
      bloqueElegido.datos.forEach(d => {
        const id = parseInt(d.paramId);
        const val = parseFloat(d.valor);
        if (id === 1) hs = val;
        if (id === 2) hmax = val;
        if (id === 4) tp = val;
        if (id === 6) dir = val;
      });
    }

    if (hs === null) throw new Error('El registro no contiene datos de oleaje');

    return res.status(200).json({
      hs: Number(hs.toFixed(2)),
      hmax: hmax ? Number(hmax.toFixed(2)) : Number((hs * 1.5).toFixed(2)),
      tp: tp ? Number(tp.toFixed(1)) : null,
      dir: gradosACardinal(dir),
      fechaHora: bloqueElegido.fecha
    });

  } catch (error) {
    return res.status(500).json({ 
      error: true, 
      mensaje: error.message 
    });
  }
}

function gradosACardinal(grados) {
  if (grados === null || isNaN(grados)) return '--';
  const rumbos = ['N', 'NE', 'E', 'SE', 'S', 'SO', 'O', 'NO'];
  const idx = Math.round(((grados % 360) + 360) % 360 / 45) % 8;
  return rumbos[idx];
}
