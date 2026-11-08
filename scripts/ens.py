"""
WaveLog — ECMWF ENS de olas (WAM ensemble, 50 miembros) para Barcelona.

Baja del open data de ECMWF (data.ecmwf.int, peticiones en paralelo) solo la Hs (swh) de los miembros
perturbados del último run 00z/12z, saca las celdas de Castelldefels y Barcelona
y lo sube a Supabase Storage (wavelog/ens.json, público) los 50 valores + percentiles por hora.

Open-Meteo acepta el modelo ecmwf_wam025_ensemble pero hoy devuelve todo null,
por eso se va a la fuente.

Variables de entorno: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
Uso local sin Supabase: python scripts/ens.py --dry-run
"""
import json
import os
import sys
import tempfile
import urllib.request
import time
import urllib.error
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone

import eccodes
import numpy as np

# Mismo punto de rejilla 0.25° que usa Open-Meteo para el ECMWF determinista del oracle
# Celdas 0.25° con dato más cercanas a la costa (las de la orilla salen como tierra)
PUNTOS = {
    "castefa": {"nombre": "Castelldefels", "lat": 41.25, "lon": 2.00},
    "bcn":     {"nombre": "Barcelona",     "lat": 41.25, "lon": 2.25},
}
# 3 h los 3 primeros días (cuadra con las tarjetas horarias), 6 h hasta el día 7
BUCKET = "wavelog"
STEPS = list(range(0, 73, 3)) + list(range(78, 169, 6))


def pasos(run):
    """Los runs 06z/18z solo llegan a +144 h."""
    return [s for s in STEPS if run.hour in (0, 12) or s <= 144]


ROOT = "https://data.ecmwf.int/forecasts"  # el espejo de AWS da 503 desde GitHub Actions


def _get(url, rango=None):
    req = urllib.request.Request(url, headers={"Range": f"bytes={rango[0]}-{rango[1]}"} if rango else {})
    ultimo = None
    for intento in range(6):
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            if e.code == 404:
                raise
            ultimo = e
        except Exception as e:
            ultimo = e
        time.sleep(3 * (intento + 1))
    raise RuntimeError(f"No se pudo bajar {url} ({ultimo})")


def _base(run):
    return f"{ROOT}/{run:%Y%m%d}/{run:%H}z/ifs/0p25/waef/{run:%Y%m%d%H}0000"


def ultimo_run():
    """Último run (00/06/12/18z) que ya tiene publicado su último paso."""
    ahora = datetime.now(timezone.utc).replace(minute=0, second=0, microsecond=0)
    run = ahora.replace(hour=ahora.hour // 6 * 6)
    for _ in range(8):
        try:
            _get(f"{_base(run)}-{pasos(run)[-1]}h-waef-ef.index", (0, 0))
            return run
        except Exception:
            run -= timedelta(hours=6)
    raise RuntimeError("No encuentro ningún run del ENS publicado")


def json_actual():
    """El ens.json que hay ahora en Storage (o None)."""
    url = os.environ["SUPABASE_URL"].rstrip("/") + f"/storage/v1/object/public/{BUCKET}/ens.json"
    try:
        with urllib.request.urlopen(url + f"?t={int(time.time())}", timeout=30) as r:
            return json.loads(r.read())
    except Exception:
        return None


def descargar(path, run):
    """Solo los mensajes swh de cada paso, con peticiones Range en paralelo."""
    print(f"Run ENS: {run:%Y-%m-%d %H}z · {len(pasos(run))} pasos")
    trozos = []
    for step in pasos(run):
        url = f"{_base(run)}-{step}h-waef-ef"
        rangos = sorted((m["_offset"], m["_offset"] + m["_length"] - 1)
                        for m in map(json.loads, _get(url + ".index").decode().splitlines())
                        if m.get("param") == "swh")
        # Junta rangos cercanos: menos peticiones (lo que sobra se descarta al leer)
        juntos = [list(rangos[0])]
        for a, b in rangos[1:]:
            if a - juntos[-1][1] <= 200_000:
                juntos[-1][1] = max(juntos[-1][1], b)
            else:
                juntos.append([a, b])
        trozos += [(url + ".grib2", tuple(r)) for r in juntos]
    with ThreadPoolExecutor(max_workers=6) as pool, open(path, "wb") as f:
        for datos in pool.map(lambda t: _get(*t), trozos):
            f.write(datos)
    print(f"{len(trozos)} peticiones · {os.path.getsize(path) / 1e6:.0f} MB")
    return run


def extraer(path):
    """{punto: {step: [hs de cada miembro]}} para cada celda de PUNTOS."""
    por_punto, idx = {k: {} for k in PUNTOS}, None
    with open(path, "rb") as f:
        while True:
            gid = eccodes.codes_grib_new_from_file(f)
            if gid is None:
                break
            try:
                if eccodes.codes_get_string(gid, "shortName") != "swh":
                    continue
                if idx is None:
                    idx = {}
                    for k, p in PUNTOS.items():
                        near = eccodes.codes_grib_find_nearest(gid, p["lat"], p["lon"])[0]
                        idx[k] = near["index"]
                        print(f"{p['nombre']}: celda {near['lat']:.2f}, {near['lon']:.2f}")
                missing = eccodes.codes_get_double(gid, "missingValue")
                step = eccodes.codes_get_long(gid, "step")
                for k, i in idx.items():
                    v = eccodes.codes_get_double_element(gid, "values", i)
                    if v != missing and not np.isnan(v):
                        por_punto[k].setdefault(step, []).append(round(float(v), 3))
            finally:
                eccodes.codes_release(gid)
    return por_punto


def filas(run, por_paso):
    out = []
    for step in sorted(por_paso):
        m = por_paso[step]
        if len(m) < 10:
            continue
        p10, p25, p50, p75, p90 = (round(float(x), 3) for x in np.percentile(m, [10, 25, 50, 75, 90]))
        out.append({
            "valid_time": (run + timedelta(hours=step)).strftime("%Y-%m-%dT%H:00:00Z"),
            "run_time": run.strftime("%Y-%m-%dT%H:00:00Z"),
            "lead_hours": step,
            "n": len(m),
            "p10": p10, "p25": p25, "p50": p50, "p75": p75, "p90": p90,
            "miembros": m,
        })
    return out


def _supabase(method, ruta, cuerpo, extra=None):
    base = os.environ["SUPABASE_URL"].rstrip("/")
    key = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
    req = urllib.request.Request(base + ruta, data=cuerpo, method=method, headers={
        "apikey": key, "Authorization": f"Bearer {key}", "Content-Type": "application/json", **(extra or {})})
    try:
        with urllib.request.urlopen(req) as r:
            return r.status
    except urllib.error.HTTPError as e:
        return e.code


def guardar(run, puntos):
    """Sube ens.json a un bucket público de Supabase Storage (no hace falta crear tablas)."""
    estado = _supabase("POST", "/storage/v1/bucket",
                       json.dumps({"id": BUCKET, "name": BUCKET, "public": True}).encode())
    print(f"Bucket {BUCKET}: HTTP {estado} (400/409 = ya existía)")
    # Un run 06z/18z llega a +144 h: el último día se completa con el run anterior
    previo = (json_actual() or {}).get("puntos", {})
    for k, p in puntos.items():
        fin = p["horas"][-1]["valid_time"]
        p["horas"] += [h for h in previo.get(k, {}).get("horas", []) if h["valid_time"] > fin]
    cuerpo = json.dumps({"run_time": run.strftime("%Y-%m-%dT%H:00:00Z"), "puntos": puntos}).encode()
    estado = _supabase("POST", f"/storage/v1/object/{BUCKET}/ens.json", cuerpo,
                       {"x-upsert": "true", "cache-control": "max-age=300"})
    print(f"Subida ens.json: HTTP {estado}")
    if estado >= 300:
        sys.exit(1)


def main():
    run = ultimo_run()
    run_iso = run.strftime("%Y-%m-%dT%H:00:00Z")
    previo = json_actual()
    if previo and previo.get("run_time") == run_iso and "--forzar" not in sys.argv:
        print(f"El run {run:%Y-%m-%d %H}z ya está subido; nada que hacer.")
        return
    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, "ens.grib2")
        descargar(path, run)
        por_punto = extraer(path)
    puntos = {}
    for k, p in PUNTOS.items():
        rows = filas(run, por_punto[k])
        if not rows:
            print(f"⚠ {p['nombre']}: sin datos (¿celda de tierra?)")
            continue
        r = rows[8]
        print(f"{p['nombre']}: {len(rows)} pasos · {r['n']} miembros · "
              f"+{r['lead_hours']}h P10 {r['p10']} · P50 {r['p50']} · P90 {r['p90']}")
        puntos[k] = {**p, "horas": rows}
    if not puntos:
        sys.exit("Sin datos en ningún punto")
    if "--dry-run" in sys.argv:
        return
    guardar(run, puntos)


if __name__ == "__main__":
    main()
