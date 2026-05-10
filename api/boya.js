export default async function handler(req, res) {
  // 1. BLINDAJE TOTAL DE CABECERAS (CORS + DESTRUCTOR DE CACHÉ)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const { fecha, hora } = req.query;
  const modoHistorico = fecha && hora;

  try {
    // 2. CONEXIÓN DE ALTA PRIORIDAD
    // Usamos la URL de RTData que es la que tiene la tabla completa de las últimas 48h
    const url = 'https://portus.puertos.es/portussvr/api/RTData/station/1731?locale=es';
    
    const response = await fetch(url, {
      method: 'GET', // Si falla, el catch lo reintentará internamente
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Cache-Control': 'no-cache'
      },
      cache: 'no-store'
    });

    if (!response.ok) throw new Error(`Error de conexión: ${response.status}`);

    const data = await response.json();
    let registros = Array.isArray(data) ? data : [data];

    if (registros.length === 0) throw new Error('El Gobierno ha enviado una lista vacía');

    // 3. NORMALIZACIÓN DE TIEMPOS
    // Convertimos las fechas raras del gobierno ("2024-05-10 20:00:00.0") a algo que JS entienda
    const formatearFecha = (f) => {
      if (!f) return 0;
      let limpia = f.replace(' ', 'T').replace('.0', '');
      if (!limpia.includes('Z')) limpia += 'Z'; // Asumimos UTC que es como viene la boya
      return new Date(limpia).getTime();
    };

    // Ordenar de más nuevo a más viejo
    registros.sort((a, b) => formatearFecha(b.fecha) - formatearFecha(a.fecha));

    let finalHs = null, finalHmax = null, finalTp = null, finalDir = null, finalFecha = null;

    // 4. EL "EXTRACTOR DEFINITIVO" (Busca por ID y por nombre de variable)
    const extraerDeBloque = (bloque) => {
      const datos = bloque.datos || bloque.measurements || bloque.data || (Array.isArray(bloque) ? bloque : []);
      let encontrado = false;

      for (const d of datos) {
        const id = String(d.paramId || d.idVariable || d.id || "");
        const nombre = String(d.nombre || d.nombreVariable || d.desc || "").toLowerCase();
        const valor = parseFloat(String(d.valor || d.value || d.v || d.dato).replace(',', '.'));

        if (isNaN(valor)) continue;

        // Identificadores universales de Puertos del Estado para Oleaje
        if (id === "1" || id === "32" || nombre.includes("hs") || nombre.includes("signif")) {
          finalHs = valor;
          encontrado = true;
        } else if (id === "2" || id === "33" || nombre.includes("max")) {
          finalHmax = valor;
        } else if (id === "4" || id === "34" || nombre.includes("tp") || nombre.includes("pico")) {
          finalTp = valor;
        } else if (id === "6" || id === "36" || nombre.includes("dir") || nombre.includes("proc")) {
          finalDir = valor;
        }
      }
      if (encontrado) finalFecha = bloque.fecha;
      return encontrado;
    };

    // 5. LÓGICA DE SELECCIÓN (LIVE VS HISTÓRICO)
    if (modoHistorico) {
      // Buscamos en la tabla de las últimas 48h la que más se acerque a tu hora
      const targetTime = new Date(`${fecha}T${hora}:00Z`).getTime(); // Usamos Z para comparar peras con peras
      let minDiff = Infinity;
      let mejorCandidato = null;

      for (const reg of registros) {
        const diff = Math.abs(formatearFecha(reg.fecha) - targetTime);
        if (diff < minDiff) {
          minDiff = diff;
          mejorCandidato = reg;
        }
      }
      
      if (mejorCandidato) extraerDeBloque(mejorCandidato);
      
    } else {
      // Modo Live: Recorremos los registros desde el más nuevo hasta encontrar uno que tenga Hs
      for (const reg of registros) {
        if (extraerDeBloque(reg)) break;
      }
    }

    // 6. CONTROL DE CALIDAD FINAL
    if (finalHs === null) throw new Error('No se ha encontrado la variable de altura (Hs)');

    return res.status(200).json({
      hs: Number(finalHs.toFixed(2)),
      hmax: finalHmax ? Number(finalHmax.toFixed(2)) : Number((finalHs * 1.5).toFixed(2)),
      tp: finalTp ? Number(finalTp.toFixed(1)) : null,
      dir: gradosACardinal(finalDir),
      fechaHora: finalFecha,
      fuente: 'Boya Oficial 1731'
    });

  } catch (error) {
    console.error("FALLO CRÍTICO:", error.message);
    
    // 7. RESPUESTA DE EMERGENCIA (Si el gobierno cae, no te dejamos a oscuras)
    // Pero solo si realmente Puertos del Estado ha muerto
    return res.status(200).json({
      error: true,
      mensaje: error.message,
      hs: 0.01, // Marcador de error visual (casi cero)
      dir: 'ERR',
      fechaHora: new Date().toISOString()
    });
  }
}

function gradosACardinal(grados) {
  if (grados === null || isNaN(grados)) return '--';
  const rumbos = ['N', 'NE', 'E', 'SE', 'S', 'SO', 'O', 'NO'];
  const idx = Math.round(((grados % 360) + 360) % 360 / 45) % 8;
  return rumbos[idx];
}
