# LaHave River · WaterWatch — deploy bundle

A **fully static** site: just HTML, CSS, JS, and a prebuilt `static/data.json`.
No server, no build step, no API keys, no environment variables. Everything
loads over relative paths; the only external requests are Google Fonts, the
Water Quality Index colours, and OpenStreetMap map tiles (all public, HTTPS).

## What's in here
```
index.html              the app
static/data.json        prebuilt analysis (3.3 MB) from the real dataset
static/css/app.css
static/js/app.js
static/vendor/           Leaflet, Chart.js, date-fns (vendored — no CDN)
.nojekyll               tells GitHub Pages to serve /static as-is
```

## Deploy — pick one (all free)

### Option A · Netlify Drop (fastest, no account needed to preview)
1. Go to https://app.netlify.com/drop
2. Drag this whole `dist` folder onto the page.
3. You get a live `https://<random>.netlify.app` URL in seconds.
   (Sign in to keep it and set a custom name.)

### Option B · GitHub Pages
1. Create a repo and push the **contents** of this folder to it
   (so `index.html` is at the repo root).
   ```
   git init && git add . && git commit -m "WaterWatch"
   git branch -M main
   git remote add origin https://github.com/<you>/<repo>.git
   git push -u origin main
   ```
2. Repo → Settings → Pages → Source: "Deploy from a branch" → `main` / `/ (root)`.
3. Wait ~1 min; the URL is `https://<you>.github.io/<repo>/`.
   (The included `.nojekyll` ensures the `static/` folder is served correctly.)

### Option C · Cloudflare Pages
1. https://pages.cloudflare.com → "Upload assets" (or connect the GitHub repo).
2. Drop this folder; no build command, output directory = `/`.

## Local preview (optional)
```
python -m http.server 8080 --bind 127.0.0.1 --directory .
# then open http://127.0.0.1:8080/
```
Do not open `index.html` via `file://` — the browser blocks `fetch()` of
`data.json` under the file protocol. Use any static server (the command above,
or the hosts listed).

## Data & attribution
Water-quality data: **Coastal Action** — LaHave River Water Quality Monitoring,
published on **DataStream** (The Gordon Foundation). ~56,000 measurements, 20
stations, 2007–2026. The Water Quality Index follows the CCME method with a
coverage-weighted reliability tier; naturally acidic pH and estuarine salinity
are treated as natural conditions. Built for a hackathon — **not intended for
regulatory use.** Attribution and this disclaimer are shown in the app footer.

## Regenerating data.json (only if the source CSV changes)
The parent project holds the pipeline. From there:
```
python serve.py --build      # rewrites static/data.json
```
Then recopy `static/data.json` into this bundle. For a plain deploy you never
need this — the bundled file is complete.
