"""
WaveLog — ECMWF ENS de olas (WAM ensemble, 50 miembros) para Barcelona.

Baja del open data de ECMWF (espejo de AWS, peticiones en paralelo) solo la Hs (swh) de los miembros
perturbados del último run 00z/12z, saca el punto de rejilla frente a Barcelona
y guarda en Supabase (tabla ens_waves) los 50 valores + percentiles por hora.

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
LAT, LON = 41.25, 2.25
# 3 h los 3 primeros días (cuadra con las tarjetas horarias), 6 h hasta el día 7
STEPS = list(range(0, 73, 3)) + list(range(78, 169, 6))


ROOT = "https://ecmwf-forecasts.s3.eu-central-1.amazonaws.com"


def _get(url, rango=None):
    req = urllib.request.Request(url, headers={"Range": f"bytes={rango[0]}-{rango[1]}"} if rango else {})
    for intento in range(4):
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            if e.code == 404:
                raise
        except Exception:
            pass
        time.sleep(2 * (intento + 1))
    raise RuntimeError(f"No se pudo bajar {url}")


def _base(run):
    return f"{ROOT}/{run:%Y%m%d}/{run:%H}z/ifs/0p25/waef/{run:%Y%m%d%H}0000"


def ultimo_run():
    """Último run 00z/12z que ya tiene publicado el paso +168 h."""
    ahora = datetime.now(timezone.utc).replace(minute=0, second=0, microsecond=0)
    run = ahora.replace(hour=12 if ahora.hour >= 12 else 0)
    for _ in range(6):
        try:
            _get(f"{_base(run)}-{STEPS[-1]}h-waef-ef.index", (0, 0))
            return run
        except Exception:
            run -= timedelta(hours=12)
    raise RuntimeError("No encuentro ningún run del ENS publicado")


def descargar(path):
    """Solo los mensajes swh de cada paso, con peticiones Range en paralelo."""
    run = ultimo_run()
    print(f"Run ENS: {run:%Y-%m-%d %H}z · {len(STEPS)} pasos")
    trozos = []
    for step in STEPS:
        url = f"{_base(run)}-{step}h-waef-ef"
        for linea in _get(url + ".index").decode().splitlines():
            m = json.loads(linea)
            if m.get("param") == "swh":
                trozos.append((url + ".grib2", (m["_offset"], m["_offset"] + m["_length"] - 1)))
    with ThreadPoolExecutor(max_workers=32) as pool, open(path, "wb") as f:
        for datos in pool.map(lambda t: _get(*t), trozos):
            f.write(datos)
    print(f"{len(trozos)} campos bajados")
    return run


def extraer(path):
    """{step: [hs de cada miembro]} en el punto LAT/LON."""
    por_paso, idx = {}, None
    with open(path, "rb") as f:
        while True:
            gid = eccodes.codes_grib_new_from_file(f)
            if gid is None:
                break
            try:
                if idx is None:
                    near = eccodes.codes_grib_find_nearest(gid, LAT, LON)[0]
                    idx = near["index"]
                    print(f"Punto de rejilla: {near['lat']:.2f}, {near['lon']:.2f}")
                v = eccodes.codes_get_double_element(gid, "values", idx)
                missing = eccodes.codes_get_double(gid, "missingValue")
                step = eccodes.codes_get_long(gid, "step")
                if v != missing and not np.isnan(v):
                    por_paso.setdefault(step, []).append(round(float(v), 3))
            finally:
                eccodes.codes_release(gid)
    return por_paso


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


def guardar(rows):
    url = os.environ["SUPABASE_URL"].rstrip("/") + "/rest/v1/ens_waves?on_conflict=valid_time"
    key = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
    req = urllib.request.Request(url, data=json.dumps(rows).encode(), method="POST", headers={
        "apikey": key, "Authorization": f"Bearer {key}", "Content-Type": "application/json",
        "Prefer": "resolution=merge-duplicates,return=minimal",
    })
    with urllib.request.urlopen(req) as r:
        print(f"Supabase: HTTP {r.status}")


def main():
    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, "ens.grib2")
        run = descargar(path)
        print(f"Descargado: {os.path.getsize(path) / 1e6:.0f} MB")
        rows = filas(run, extraer(path))
    if not rows:
        sys.exit("Sin datos en el punto: ¿celda de tierra?")
    print(f"{len(rows)} pasos · {rows[0]['n']} miembros · "
          f"ej. +{rows[8]['lead_hours']}h: P10 {rows[8]['p10']} · P50 {rows[8]['p50']} · P90 {rows[8]['p90']}")
    if "--dry-run" in sys.argv:
        return
    guardar(rows)


if __name__ == "__main__":
    main()
