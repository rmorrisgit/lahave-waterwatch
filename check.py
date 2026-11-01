import json
d = json.load(open('static/data.json', encoding='utf-8'))
w = sorted(d['wqi'].values(), key=lambda x: x['score'])
print("=== WQI (worst first) ===")
for x in w:
    print(f"{x['score']:5.1f} {x['rating']:10} {x['station']:22} {x['tests_failed']}/{x['tests_total']}")
print("\n=== Top exceedances ===")
exc = [a for a in d['anomalies'] if a['exceedance']][:8]
for a in exc:
    print(a['date'], a['station'][:16].ljust(16), a['param'][:20].ljust(20), a['value'], a['exceedance'])
