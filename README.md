# GCMap Modern

GCMap Modern is a browser-based great-circle route mapper. Airport codes are assembled into one
or more routes; the application draws the great-circle path between consecutive airports on an
Apple Maps-style map and reports the distance and initial bearing of every leg, along with the
route total in kilometres, statute miles, or nautical miles.

English | [简体中文](README.zh-CN.md)

## Features

- **Dual basemaps:** A vector basemap in an Apple Maps-inspired palette, with global landcover
  imagery underneath, terrain hillshade, and ground-use coloring; plus a satellite mode built on
  Stadia imagery with an in-browser per-pixel ocean tint. Place labels stay readable in both modes.
- **3D globe:** At world zoom levels the map renders as a 3D globe floating in a starfield;
  zooming in transitions smoothly back to the flat map, and a reset entry restores the
  north-up, level view at any time.
- **Dark mode:** Panels and controls ship in a frosted dark theme by default; the map options
  menu switches back to light at any time (`?theme=light` deep-links it).
- **Multiple routes:** Routes are managed in a list; each has independent visibility, color,
  and line width, and new routes are assigned colors automatically.
- **Great-circle geometry:** Per-leg distance and initial bearing, route totals, and
  km / mi / nm conversion. Routes crossing the antimeridian are drawn continuously.
- **Real-world routes via SimBrief:** A route can be replaced with its filed airway path: the
  app opens SimBrief's dispatch page pre-filled with the departure, arrival, and aircraft type
  (A359 by default); once the plan is generated there, it is imported back automatically and
  drawn through the actual waypoints. Requires a free SimBrief account; no API key needed.
- **Bilingual place labels:** Map labels switch between Simplified Chinese and English, and can
  be hidden entirely.
- **Airport search:** 8,799 airports from the OurAirports database, searchable by IATA/ICAO
  code or by name.
- **Two input modes:** A tag-flow input for interactive composition, and a raw-text mode that
  accepts several routes pasted at once.
- **Map options menu:** Basemap, 3D globe, view reset, place labels, and language live behind
  a single button in the top-right corner.
- **URL deep links:** Routes, language, basemap, projection, unit, label visibility, and theme
  are all encoded in the URL and restored on load.

## Getting started

Requirements: Node.js 20.19+ or 22.12+ (per Vite 8) and npm.

```bash
npm install
npm run dev
```

The development server runs at http://127.0.0.1:5173.

### Optional: Stadia satellite imagery

The satellite basemap uses Stadia Maps imagery with an ocean tint applied per pixel in the
browser. To activate it, grab a free API key at [client.stadiamaps.com](https://client.stadiamaps.com/signup/),
create a `.env.local` file in the project root, and add:

```
VITE_STADIA_KEY=your-key-here
```

Then restart the dev server (or rebuild). Without a key the application falls back to key-free
Esri World Imagery, so a fresh checkout works out of the box. The key stays local and is never
committed (`.env*` is gitignored).

For a production build:

```bash
npm run build    # type-checks and bundles into dist/
npm run preview  # serves the production build locally
```

## URL parameters

Application state can be preset through query parameters; the URL is kept in sync with the UI.

| Parameter | Values | Description |
| --------- | ------ | ----------- |
| `route`   | `LHR-SIN-SYD;PEK-JFK` | Airport codes joined by `-` (nonstop or with stops); multiple routes separated by `;` |
| `sbr`     | polyline-encoded waypoint list | Real-route snapshot, one per SimBrief route; written automatically and restored on load |
| `sbf`     | SimBrief username | On load, imports that user's latest flight plan as a real route |
| `lang`    | `zh`, `en` | Place-label language |
| `base`    | `vector`, `satellite` | Basemap mode |
| `globe`   | `1` | `1` renders the map as a 3D globe at low zoom; omit for the flat map |
| `u`       | `km`, `mi`, `nm` | Distance unit |
| `labels`  | `0` | `0` hides place labels; omit to show them |
| `theme`   | `light` | `light` uses the light UI theme; omit for dark mode |

Example: `/?route=LHR-SIN-SYD;PEK-JFK&base=satellite&u=nm`

## Airport data

`src/data/airports.json` is generated from the [OurAirports](https://ourairports.com/data/)
database (large/medium/small airports carrying an IATA code, plus large airports that have only
an ICAO code) and is committed to this repository, so a fresh checkout works without
regenerating it.

To rebuild from a newer OurAirports snapshot, download `airports.csv`, place it at
`scripts/airports.csv`, and run:

```bash
npm run build:airports
```

## Project structure

```
├── index.html
├── src/
│   ├── App.tsx                 # application state and URL synchronization
│   ├── app.css                 # UI styling
│   ├── components/             # search panel, route list, route summary, top-right controls
│   ├── data/                   # airports.json (generated) and search helpers
│   ├── geo/greatCircle.ts      # haversine distance, initial bearing, slerp sampling, units
│   ├── i18n/strings.ts         # zh/en UI strings
│   ├── simbrief/simbrief.ts    # SimBrief link: dispatch redirect URL, OFP fetch/parse, route snapshots
│   └── map/
│       ├── styleFactory.ts     # adapts the generated style: layer groups, satellite layer, labels
│       ├── oceanTint.ts        # per-pixel satellite tile processing (ocean tint) via a custom protocol
│       └── MapController.ts    # MapLibre wrapper: layers, markers, basemap switching
├── design-assets/              # generated style and landcover assets consumed by the build
├── desktop/                    # optional Electron shell that packages the app for Windows
└── scripts/build-airports.mjs  # OurAirports CSV -> src/data/airports.json
```

## Desktop app (Windows)

An optional Electron shell packages the production build as a Windows desktop
application. It serves the same web app from a loopback port and opens it in
its own window; external links (SimBrief dispatch, map attribution) open in the
system browser. The shell lives in `desktop/` — see
[desktop/README.md](desktop/README.md) for build instructions (Node.js
required; `npm install && npm run dist` inside `desktop/`).

Like the web build, the desktop build reads `VITE_STADIA_KEY` from the project
root's `.env.local`; without a key it runs with the key-free Esri imagery
fallback.

## Data sources and attribution

The application renders third-party map data. The attribution control in the lower-right corner
of the map carries these credits; per the respective licenses, it must not be removed.

- **Vector tiles and place names** — served by OpenFreeMap; underlying map data
  © OpenStreetMap contributors (ODbL).
- **Vector basemap style** — generated for this project; landcover and ground-use colors are
  derived from OSM Carto (CC0).
- **Land cover base imagery** — NASA EOSDIS GIBS, restyled for this project.
- **Terrain hillshade** — AWS Open Data Terrain Tiles (Mapzen).
- **Satellite imagery** — Stadia Maps (© CNES, Distribution Airbus DS, © Airbus DS, ©
  PlanetObserver — Contains Copernicus Data); the ocean tint is applied in-browser. Without an
  API key the app falls back to Esri World Imagery (Esri, Maxar, Earthstar Geographics).
- **Airport database** — OurAirports.com (public domain).
- **Flight plan data** — [SimBrief](https://www.simbrief.com); real routes reflect flight plans
  generated by the user's own SimBrief account (free registration).
- **Typeface** — Inter (SIL Open Font License).

## License

The source code is released under the [MIT License](LICENSE). The map data, imagery, and the
airport database listed above remain subject to their own licenses and attribution
requirements.
