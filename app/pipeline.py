"""
LaHave WaterWatch — data pipeline (v2: coverage-aware & accuracy-hardened).

Transforms the raw DataStream / WQX long-format CSV into analysis-ready
structures the frontend serves. Everything downstream renders from the real
data; no values are fabricated or imputed.

What changed in v2 (environmental-analysis improvements):
  * UNIT-AWARE guideline tests. Fecal Coliform appears in two units
    (cfu/100mL and #/mL); applying one threshold to both is a ~100x error, so
    guideline tests now run only on the canonical unit for each parameter.
  * PLAUSIBILITY QA. Physically impossible values (e.g. a 1360 mg/L dissolved
    oxygen reading — saturation here is ~14 mg/L) are quarantined: counted and
    surfaced as suspected data-entry errors, never plotted as real signal nor
    fed to the WQI / statistics.
  * PER-YEAR AGGREGATES. For every station|parameter we emit compact yearly
    buckets (n, sum, sumsq, min, max, sorted values, guideline pass/fail).
    The frontend recomputes WQI, means, and medians for ANY selected year
    window from these buckets — so station rankings can be compared over a
    common, user-chosen period instead of only over mismatched lifetimes.
  * WQI CONFIDENCE. Each station's index carries a confidence tier derived
    from how many guideline parameters it actually measures, how many tests
    back it, and how many years it spans — so a 16-sample, single-year station
    is never ranked as if it were comparable to a 20-year record.
  * ANOMALY vs EXCEEDANCE separated. A statistical outlier (robust MAD
    z-score) is labelled "unusual reading — needs review", NOT a confirmed
    environmental problem. Guideline exceedances are labelled separately and
    annotated with ecological context (e.g. chloride spikes at estuary
    stations are natural salt-wedge intrusion, not pollution).

Data source: Coastal Action — LaHave River Water Quality Monitoring,
published on DataStream (Gordon Foundation).
"""
from __future__ import annotations

import math
from datetime import datetime
from functools import lru_cache
from pathlib import Path

import numpy as np
import pandas as pd

DATA_PATH = Path(__file__).resolve().parent.parent / "data" / "lahave_water_quality.csv"

# --- Parameters we surface as first-class, with display metadata ------------
# Canonical names match CharacteristicName in the dataset exactly.
# `canonical_unit` (lowercased) pins which unit the guideline applies to;
# `plausible` is a physical sanity window [lo, hi] used only to quarantine
# impossible values, never to clip real data.
PARAM_META = {
    "Temperature, water":        {"key": "temp",     "label": "Water Temperature", "unit": "°C",     "group": "Field",     "canonical_unit": "deg c", "plausible": [-2, 40]},
    "Dissolved oxygen (DO)":     {"key": "do",       "label": "Dissolved Oxygen",  "unit": "mg/L",   "group": "Field",     "canonical_unit": "mg/l",  "plausible": [0, 20]},
    "Dissolved oxygen saturation": {"key": "do_sat", "label": "DO Saturation",     "unit": "%",      "group": "Field",     "canonical_unit": "%",     "plausible": [0, 200]},
    "pH":                        {"key": "ph",       "label": "pH",                "unit": "",       "group": "Field",     "canonical_unit": "",      "plausible": [2, 12]},
    "Specific conductance":      {"key": "cond",     "label": "Specific Conductance","unit": "µS/cm","group": "Field",     "canonical_unit": "us/cm", "plausible": [0, 60000]},
    "Salinity":                  {"key": "salinity", "label": "Salinity",          "unit": "ppt",    "group": "Field",     "canonical_unit": "ppth",  "plausible": [0, 40]},
    "Total dissolved solids":    {"key": "tds",      "label": "Total Dissolved Solids","unit": "mg/L","group": "Field",   "canonical_unit": "mg/l",  "plausible": [0, 50000]},
    "Total Phosphorus, mixed forms": {"key": "tp",   "label": "Total Phosphorus",  "unit": "mg/L",   "group": "Nutrients", "canonical_unit": "mg/l",  "plausible": [0, 5]},
    "Total Nitrogen, mixed forms": {"key": "tn",     "label": "Total Nitrogen",    "unit": "mg/L",   "group": "Nutrients", "canonical_unit": "mg/l",  "plausible": [0, 50]},
    "Inorganic nitrogen (nitrate and nitrite)": {"key": "nox", "label": "Nitrate+Nitrite", "unit": "mg/L", "group": "Nutrients", "canonical_unit": "mg/l", "plausible": [0, 50]},
    "Total suspended solids":    {"key": "tss",      "label": "Total Suspended Solids","unit": "mg/L","group": "Nutrients","canonical_unit": "mg/l",  "plausible": [0, 2000]},
    "Chloride":                  {"key": "chloride", "label": "Chloride",          "unit": "mg/L",   "group": "Ions",      "canonical_unit": "mg/l",  "plausible": [0, 25000]},
    "Organic carbon":            {"key": "doc",      "label": "Organic Carbon",    "unit": "mg/L",   "group": "Nutrients", "canonical_unit": "mg/l",  "plausible": [0, 100]},
    "Fecal Coliform":            {"key": "fecal",    "label": "Fecal Coliform",    "unit": "CFU/100mL","group": "Bacteria","canonical_unit": "cfu/100ml","plausible": [0, 100000]},
}

# --- Guideline thresholds (used for the Water Quality Index & exceedances) ---
# Based on CCME Canadian Water Quality Guidelines for the Protection of Aquatic
# Life and recreational-water guidance. `context` explains ecological nuance so
# the UI never presents a natural condition as pollution. `wqi_weight` lets a
# parameter known to be governed by natural conditions in THIS watershed (pH in
# a tannin-stained blackwater river; chloride at estuary stations) contribute
# to the index with reduced dominance rather than driving the whole score.
GUIDELINES = {
    "do":       {"min": 6.0,  "label": "DO ≥ 6.0 mg/L (aquatic life)",
                 "context": "Low dissolved oxygen stresses fish and invertebrates."},
    "ph":       {"min": 6.5, "max": 9.0, "label": "pH 6.5–9.0 (aquatic life)",
                 "wqi_weight": 0.5, "wqi_skip_low": True,
                 "context": "The LaHave is a naturally acidic, tannin-stained Atlantic watershed; "
                            "pH routinely sits below 6.5 for geological reasons (organic acids from "
                            "peatlands), NOT pollution. The 6.5 lower bound is shown for reference but "
                            "is excluded from WQI scoring here; only the upper bound (9.0) is scored. "
                            "Low-pH readings are therefore NOT counted as environmental failures."},
    "tp":       {"max": 0.05, "label": "Total P ≤ 0.05 mg/L (rivers)",
                 "context": "Elevated phosphorus can drive nuisance algal growth (eutrophication)."},
    "nox":      {"max": 3.0,  "label": "Nitrate+Nitrite ≤ 3.0 mg/L",
                 "context": "Nitrogen enrichment from runoff / wastewater."},
    "fecal":    {"max": 200,  "label": "Fecal coliform ≤ 200 CFU/100mL (rec.)",
                 "context": "Recreational-water indicator of fecal contamination."},
    "tss":      {"max": 25,   "label": "TSS ≤ 25 mg/L (guidance)",
                 "context": "Suspended sediment from erosion / runoff; reduces light and clogs gills."},
    "chloride": {"max": 120,  "label": "Chloride ≤ 120 mg/L (chronic)", "wqi_weight": 0.5,
                 "context": "At the estuary (Bridgewater, Dayspring, Upper LaHave) high chloride is "
                            "natural seawater intrusion (salt wedge), not pollution. Upstream, elevated "
                            "chloride can indicate road-salt runoff. Weighted down in the WQI because "
                            "estuarine salinity is a natural gradient."},
    "temp":     {"max": 24,   "label": "Temp ≤ 24 °C (cool-water biota)",
                 "context": "Warm water holds less oxygen and stresses cool-water species."},
}

ESTUARY_CHLORIDE_NOTE = (
    "Natural estuarine salt intrusion — expected at tidewater stations, not a pollution signal."
)


def _theil_sen_slope(x: np.ndarray, y: np.ndarray) -> float:
    """Robust trend slope (per year). Median of pairwise slopes."""
    n = len(x)
    if n < 3:
        return float("nan")
    slopes = []
    for i in range(n):
        for j in range(i + 1, n):
            if x[j] != x[i]:
                slopes.append((y[j] - y[i]) / (x[j] - x[i]))
    return float(np.median(slopes)) if slopes else float("nan")


@lru_cache(maxsize=1)
def load_raw() -> pd.DataFrame:
    df = pd.read_csv(DATA_PATH, low_memory=False)
    df["ResultValue"] = pd.to_numeric(df["ResultValue"], errors="coerce")
    df["date"] = pd.to_datetime(df["ActivityStartDate"], errors="coerce")
    df = df.dropna(subset=["date"])
    df["year"] = df["date"].dt.year
    df["month"] = df["date"].dt.month
    df["unit_lc"] = df["ResultUnit"].astype(str).str.strip().str.lower()
    df["unit_lc"] = df["unit_lc"].replace({"nan": "", "none": ""})
    df["below_dl"] = df["ResultDetectionCondition"].astype(str).str.contains("Below", na=False)
    df["preliminary"] = df.get("ResultValueType", pd.Series(index=df.index, dtype=object)) \
        .astype(str).str.contains("Prelim", case=False, na=False)
    return df


def _clean(v):
    """JSON-safe float."""
    if v is None:
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    if math.isnan(f) or math.isinf(f):
        return None
    return f


def _is_estuary(station_type: str) -> bool:
    return str(station_type).strip().lower() == "estuary"


@lru_cache(maxsize=1)
def build() -> dict:
    df = load_raw()

    # ---- Stations -----------------------------------------------------------
    st = (
        df.groupby(["MonitoringLocationID", "MonitoringLocationName"])
        .agg(
            lat=("MonitoringLocationLatitude", "first"),
            lon=("MonitoringLocationLongitude", "first"),
            type=("MonitoringLocationType", "first"),
            n=("ResultValue", "size"),
            first=("date", "min"),
            last=("date", "max"),
            n_days=("date", "nunique"),
            n_years=("year", "nunique"),
        )
        .reset_index()
    )
    st = st.sort_values("lat", ascending=False).reset_index(drop=True)
    st["river_order"] = st.index

    stations = []
    for _, r in st.iterrows():
        stations.append({
            "id": int(r.MonitoringLocationID),
            "name": r.MonitoringLocationName,
            "lat": _clean(r.lat),
            "lon": _clean(r.lon),
            "type": r.type,
            "n": int(r.n),
            "n_days": int(r.n_days),
            "n_years": int(r.n_years),
            "river_order": int(r.river_order),
            "first": r.first.strftime("%Y-%m-%d"),
            "last": r.last.strftime("%Y-%m-%d"),
            "estuary": _is_estuary(r.type),
        })
    id_to_name = {s["id"]: s["name"] for s in stations}
    id_to_type = {s["id"]: s["type"] for s in stations}

    # ---- Parameters list ----------------------------------------------------
    params = [
        {"name": name,
         "key": meta["key"], "label": meta["label"], "unit": meta["unit"], "group": meta["group"],
         "guideline": GUIDELINES.get(meta["key"])}
        for name, meta in PARAM_META.items()
    ]
    key_by_name = {name: meta["key"] for name, meta in PARAM_META.items()}
    meta_by_key = {m["key"]: m for m in PARAM_META.values()}

    # ---- Tracked rows with unit-aware plausibility QA -----------------------
    tracked = df[df["CharacteristicName"].isin(PARAM_META.keys())].copy()
    tracked["pkey"] = tracked["CharacteristicName"].map(key_by_name)

    # Canonical-unit flag: a row is "on the canonical unit" if its unit matches
    # the parameter's canonical unit. pH has no unit (NaN / empty string).
    def _norm_unit(u):
        if u is None:
            return ""
        try:
            if isinstance(u, float) and math.isnan(u):
                return ""
        except (TypeError, ValueError):
            pass
        s = str(u).strip().lower()
        return "" if s in ("", "nan", "none") else s

    def _canon_ok(row):
        cu = meta_by_key[row["pkey"]]["canonical_unit"]
        u = _norm_unit(row["unit_lc"])
        return u == cu
    tracked["canon_unit"] = tracked.apply(_canon_ok, axis=1)

    # Plausibility: quarantine physically impossible values.
    def _plausible(row):
        v = row["ResultValue"]
        if v is None or (isinstance(v, float) and math.isnan(v)):
            return True  # NaN handled elsewhere
        lo, hi = meta_by_key[row["pkey"]]["plausible"]
        return lo <= v <= hi
    tracked["plausible"] = tracked.apply(_plausible, axis=1)

    # Data-quality tally (reported, never silently dropped).
    dq = {
        "implausible_values": int((~tracked["plausible"]).sum()),
        "off_unit_rows": int((~tracked["canon_unit"]).sum()),
        "below_detection": int(tracked["below_dl"].sum()),
        "preliminary_rows": int(tracked["preliminary"].sum()),
    }
    quarantined = tracked[~tracked["plausible"]].copy()
    dq_examples = []
    for _, r in quarantined.sort_values("ResultValue", ascending=False).head(12).iterrows():
        dq_examples.append({
            "station": id_to_name.get(int(r.MonitoringLocationID), "?"),
            "param": meta_by_key[r.pkey]["label"],
            "value": _clean(r.ResultValue),
            "unit": r.ResultUnit,
            "date": r.date.strftime("%Y-%m-%d"),
            "reason": "outside physical range",
        })

    # Analysis-grade rows: plausible AND numeric. A row on a NON-canonical unit
    # (e.g. salinity in ppth vs ppt, or fecal coliform in #/mL) is STILL valid
    # data to plot and summarise — the off-unit flag only disables guideline
    # PASS/FAIL testing for that row, so a 100x unit mismatch can't create a
    # false exceedance. `canon_unit` is carried per row for that gate.
    ana = tracked[tracked["plausible"]].dropna(subset=["ResultValue"]).copy()

    # ---- Per station/parameter: full point series + lifetime stats ----------
    # Plus PER-YEAR AGGREGATE buckets for client-side windowed recompute.
    series = {}        # "sid|pkey" -> [[date, value], ...]  (analysis-grade)
    stats = {}         # "sid|pkey" -> lifetime {min,max,mean,median,n,trend,...}
    yearagg = {}       # "sid|pkey" -> { year: {n,sum,sumsq,min,max,vals[],fail,tested} }
    all_anoms = []

    for (sid, pkey), g in ana.groupby(["MonitoringLocationID", "pkey"]):
        g = g.sort_values("date")
        vals = g["ResultValue"].to_numpy()
        if len(vals) == 0:
            continue
        sid = int(sid)
        key = f"{sid}|{pkey}"
        series[key] = [[d.strftime("%Y-%m-%d"), _clean(v)] for d, v in zip(g["date"], vals)]

        med = float(np.median(vals))
        mad = float(np.median(np.abs(vals - med))) or 1e-9
        rz = 0.6745 * (vals - med) / mad
        xy = g["date"].dt.year + (g["date"].dt.day_of_year - 1) / 365.25
        slope = _theil_sen_slope(xy.to_numpy(), vals)

        stats[key] = {
            "n": int(len(vals)),
            "min": _clean(vals.min()), "max": _clean(vals.max()),
            "mean": _clean(vals.mean()), "median": med,
            "latest": _clean(vals[-1]),
            "latest_date": g["date"].iloc[-1].strftime("%Y-%m-%d"),
            "trend_per_year": _clean(slope) if len(vals) >= 6 else None,
            "n_years": int(g["year"].nunique()),
        }

        gl = GUIDELINES.get(pkey)
        est = _is_estuary(id_to_type.get(sid, ""))
        canon = g["canon_unit"].to_numpy()  # per-row: is this on the guideline unit?
        buckets = {}
        for yr, gy in g.groupby("year"):
            yv = gy["ResultValue"].to_numpy()
            yc = gy["canon_unit"].to_numpy()
            gv = yv[yc]                       # guideline-testable values this year
            fail = 0
            if gl is not None:
                if "max" in gl:
                    fail += int((gv > gl["max"]).sum())
                if "min" in gl and not gl.get("wqi_skip_low"):
                    fail += int((gv < gl["min"]).sum())
            buckets[int(yr)] = {
                "n": int(len(yv)),
                "sum": _clean(yv.sum()),
                "sumsq": _clean(float(np.square(yv).sum())),
                "min": _clean(yv.min()), "max": _clean(yv.max()),
                # ALL plausible values, for medians/means over any window.
                "vals": [_clean(v) for v in np.sort(yv)],
                # Only guideline-unit values feed WQI pass/fail testing.
                "gvals": [_clean(v) for v in np.sort(gv)] if gl is not None else [],
                "fail": fail,
                "tested": int(len(gv)) if gl is not None else 0,
            }
        yearagg[key] = buckets

        # Anomalies, exceedances & natural conditions — kept distinct so a
        # statistical outlier or an expected natural condition is never
        # presented as a confirmed environmental problem.
        skip_low = bool(gl and gl.get("wqi_skip_low"))
        for d, v, z, cu in zip(g["date"], vals, rz, canon):
            exceed = None
            if gl and cu:   # only flag against a guideline-unit reading
                if "max" in gl and v > gl["max"]:
                    exceed = "high"
                elif "min" in gl and v < gl["min"]:
                    exceed = "low"
            is_outlier = abs(z) >= 3.5
            if not (exceed or is_outlier):
                continue

            # Decide the classification & any ecological context note.
            note = None
            natural = False
            if exceed == "high" and pkey == "chloride" and est:
                natural = True
                note = ESTUARY_CHLORIDE_NOTE
            elif exceed == "low" and skip_low:   # e.g. naturally acidic pH
                natural = True
                note = ("Naturally acidic, tannin-stained blackwater system — low pH is "
                        "geological (peatland organic acids), not a pollution signal.")

            if exceed and natural:
                kind = "natural"
            elif exceed:
                kind = "exceedance"
            else:
                kind = "outlier"

            all_anoms.append({
                "station_id": sid, "station": id_to_name[sid],
                "pkey": pkey, "param": meta_by_key[pkey]["label"],
                "date": d.strftime("%Y-%m-%d"), "value": _clean(v),
                "zscore": _clean(z),
                "exceedance": exceed if (exceed and not natural) else None,
                "natural": natural,
                "outlier": bool(is_outlier),        # statistical only
                "kind": kind,                       # 'exceedance'|'natural'|'outlier'
                "note": note,
            })

    # Order: confirmed exceedances first, then outliers by magnitude, then natural.
    _rank = {"exceedance": 0, "outlier": 1, "natural": 2}
    all_anoms.sort(key=lambda a: (_rank.get(a["kind"], 3), -abs(a["zscore"] or 0)))

    # ---- Lifetime WQI per station (with confidence) -------------------------
    wqi = {}
    for s in stations:
        sid = s["id"]
        years = sorted({int(y) for k, b in yearagg.items() if k.startswith(f"{sid}|") for y in b})
        rec = _wqi_for_window(sid, yearagg, years[0] if years else 0,
                              years[-1] if years else 0, id_to_name, id_to_type)
        if rec:
            wqi[sid] = rec

    # ---- Longitudinal profile (lifetime median by river order, per param) ---
    longitudinal = {}
    for pkey in meta_by_key:
        rows = []
        for s in stations:
            key = f"{s['id']}|{pkey}"
            if key in stats:
                rows.append({
                    "station": s["name"], "river_order": s["river_order"],
                    "median": stats[key]["median"], "type": s["type"],
                    "n": stats[key]["n"],
                })
        if rows:
            longitudinal[pkey] = sorted(rows, key=lambda r: r["river_order"])

    # ---- Seasonal pattern (monthly climatology) per station|param -----------
    # Median by calendar month across all years — useful to separate a seasonal
    # swing (expected) from a genuine anomaly.
    seasonal = {}
    for (sid, pkey), g in ana.groupby(["MonitoringLocationID", "pkey"]):
        by_m = g.groupby("month")["ResultValue"].median()
        if len(by_m) >= 4:
            seasonal[f"{int(sid)}|{pkey}"] = {int(m): _clean(v) for m, v in by_m.items()}

    years_all = sorted({int(y) for b in yearagg.values() for y in b})

    meta = {
        "n_measurements": int(len(df)),
        "n_analysis_grade": int(len(ana)),
        "n_stations": len(stations),
        "n_params": int(df["CharacteristicName"].nunique()),
        "date_min": df["date"].min().strftime("%Y-%m-%d"),
        "date_max": df["date"].max().strftime("%Y-%m-%d"),
        "year_min": years_all[0] if years_all else None,
        "year_max": years_all[-1] if years_all else None,
        "n_exceedances": sum(1 for a in all_anoms if a["kind"] == "exceedance"),
        "n_natural": sum(1 for a in all_anoms if a["kind"] == "natural"),
        "n_outliers": sum(1 for a in all_anoms if a["kind"] == "outlier"),
        "data_quality": dq,
        "generated": datetime.now().isoformat() + "Z",
    }

    return {
        "meta": meta,
        "stations": stations,
        "params": params,
        "series": series,
        "stats": stats,
        "yearagg": yearagg,
        "seasonal": seasonal,
        "anomalies": all_anoms,
        "dq_examples": dq_examples,
        "wqi": wqi,                 # lifetime, for default view
        "longitudinal": longitudinal,
        "years": years_all,
        "guidelines": GUIDELINES,
    }


def _confidence(params_evaluated: int, tests_total: int, n_years: int) -> dict:
    """Confidence tier for a WQI score, from coverage breadth & depth.
    Prevents a thin, single-year station being ranked like a 20-year record."""
    score = 0
    score += min(params_evaluated, 8) / 8.0          # parameter breadth
    score += min(tests_total, 400) / 400.0           # test volume
    score += min(n_years, 10) / 10.0                 # temporal coverage
    score /= 3.0
    if params_evaluated >= 6 and tests_total >= 150 and n_years >= 5:
        tier = "high"
    elif params_evaluated >= 4 and tests_total >= 40 and n_years >= 2:
        tier = "moderate"
    else:
        tier = "low"
    return {"tier": tier, "coverage": round(score, 3)}


def _wqi_for_window(sid, yearagg, y0, y1, id_to_name, id_to_type):
    """Compute the CCME WQI for a station over [y0, y1] inclusive, from the
    per-year buckets. Mirrors the JS implementation so server & client agree."""
    est = _is_estuary(id_to_type.get(sid, ""))
    params_total, params_failed = set(), set()
    tests_total = tests_failed = 0
    excursions = []
    n_years = set()

    for pkey, gl in GUIDELINES.items():
        key = f"{sid}|{pkey}"
        buckets = yearagg.get(key)
        if not buckets:
            continue
        w = gl.get("wqi_weight", 1.0)
        skip_low = bool(gl.get("wqi_skip_low"))
        # estuarine chloride is a natural gradient — exclude from WQI there.
        if pkey == "chloride" and est:
            continue
        contributed = 0
        for yr, b in buckets.items():
            if yr < y0 or yr > y1:
                continue
            n_years.add(yr)
            for v in b.get("gvals", []):
                contributed += 1
                tests_total += 1
                failed = False
                exc = 0.0
                if "max" in gl and v > gl["max"]:
                    failed = True
                    exc = (v / gl["max"] - 1) if gl["max"] else 0
                if "min" in gl and not skip_low and 0 <= v < gl["min"]:
                    failed = True
                    exc = (gl["min"] / v - 1) if v else 0
                if failed:
                    tests_failed += 1
                    params_failed.add(pkey)
                    excursions.append(max(exc, 0) * w)
        if contributed:
            params_total.add(pkey)

    if tests_total == 0 or not params_total:
        return None

    f1 = 100 * len(params_failed) / len(params_total)
    f2 = 100 * tests_failed / tests_total
    nse = sum(excursions) / tests_total if tests_total else 0
    f3 = nse / (0.01 * nse + 0.01) if nse else 0
    score = max(0.0, min(100.0, 100 - math.sqrt(f1**2 + f2**2 + f3**2) / 1.732))

    if score >= 95:   rating = "Excellent"
    elif score >= 80: rating = "Good"
    elif score >= 65: rating = "Fair"
    elif score >= 45: rating = "Marginal"
    else:             rating = "Poor"

    conf = _confidence(len(params_total), tests_total, len(n_years))
    return {
        "station_id": sid, "station": id_to_name[sid],
        "score": round(score, 1), "rating": rating,
        "params_evaluated": len(params_total),
        "tests_failed": tests_failed, "tests_total": tests_total,
        "n_years": len(n_years),
        "confidence": conf["tier"], "coverage": conf["coverage"],
        "window": [int(y0), int(y1)],
    }


if __name__ == "__main__":
    import json
    data = build()
    print(json.dumps(data["meta"], indent=2, default=str))
    print("\nWQI sample (lifetime):")
    for w in sorted(data["wqi"].values(), key=lambda x: x["score"])[:5]:
        print(f"  {w['station']:22s} score={w['score']:5.1f} {w['rating']:9s} "
              f"conf={w['confidence']:8s} {w['params_evaluated']}/8 params "
              f"{w['tests_total']} tests {w['n_years']} yr")
    print(f"\nexceedances={data['meta']['n_exceedances']} "
          f"outliers={data['meta']['n_outliers']}")
    print("data quality:", data["meta"]["data_quality"])
