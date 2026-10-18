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
- **3D terrain:** Toggleable terrain relief (same data source as the hillshade) raises
  mountains in 3D, in both globe and flat modes.
- **Dark mode:** Panels and controls ship in a frosted dark theme by default; the map options
  menu switches back to light at any time (`?theme=light` deep-links it).
- **Multiple routes:** Routes are managed in a list; each has independent visibility, color,
  and line width, and new routes are assigned colors automatically.
- **Saved routes & local draft:** The whole route set — including colors, widths, visibility,
  and real-route waypoints — is silently kept as a local draft, so opening the bare URL
  restores your last session; sets can also be saved under a name as favorites and restored
  with one click (undoable). Favorites and the draft live in your browser only and never
  enter shared links.
- **Flight log:** Mark airports as visited from the airport card, and log a route's distance
  from the summary card; cumulative distance and the count of visited airports are tallied in
  the flight-log card. Everything stays on your device.
- **Airport card:** Clicking an airport pin on the map opens a small card with the airport's
  name, IATA/ICAO codes, city/country, elevation, and coordinates — plus the visited toggle.
- **Delete undo:** Deleting a route shows an undo entry at the bottom (for about 8 seconds)
  that restores it in place with its styling.
- **Great-circle geometry:** Per-leg distance and initial bearing, route totals, and
  km / mi / nm conversion. Routes crossing the antimeridian are drawn continuously.
- **Flight time & cruise speed:** The summary card estimates flight time per leg using a
  distance-banded cruise assumption — narrowbody M0.78 (830 km/h) under 4,000 km, widebody
  M0.85 (903 km/h) beyond — plus a per-leg taxi/climb/descent allowance. When a SimBrief plan
  is imported, the plan's own enroute time and cruise speed are shown instead. Cruise speed is
  always shown in all three units (Mach · km/h · kt); the default aircraft offered when opening
  SimBrief also follows the same 4,000 km band (A21N / A359).
- **Real-world routes via SimBrief:** A route can be replaced with its filed airway path: the
  app opens SimBrief's dispatch page pre-filled with the departure, arrival, and an aircraft
  type picked by route distance (A321neo under 4,000 km, A350-900 beyond); once the plan is
  generated there, it is imported back automatically and drawn through the actual waypoints.
  Requires a free SimBrief account; no API key needed.
- **Bilingual place labels:** Map labels switch between Simplified Chinese and English, and can
  be hidden entirely.
- **Airport search:** 8,799 airports from the OurAirports database, searchable by IATA/ICAO
  code or by name.
- **Two input modes:** A tag-flow input for interactive composition, and a raw-text mode that
  accepts several routes pasted at once.
- **Map options menu:** Basemap, 3D globe, 3D terrain, view reset, place labels, and language
  live behind a single button in the top-right corner; saved routes sit behind the bookmark
  button next to it.
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
browser. Two ways to activate it:

- **Online (no build needed):** open the map options menu in the top-right corner, paste your
  API key under "Imagery key" and press Enter — the key is stored in your browser only, and a
  "Change key" button stays there if you ever need to swap it;
- **Self-hosted:** grab a free API key at [client.stadiamaps.com](https://client.stadiamaps.com/signup/),
  create a `.env.local` file in the project root, and add:

```
VITE_STADIA_KEY=your-key-here
```

Then restart the dev server (or rebuild). Without a key the application falls back to key-free
Esri World Imagery, so a fresh checkout works out of the box. The key stays local and is never
committed (`.env*` is gitignored; a key entered in the menu lives only in your browser's
localStorage).

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
| `sbt`     | `minutes-tas-mach` | Flight-plan metadata for the matching `sbr` snapshot (enroute time and cruise speed); omitted when none |
| `sbf`     | SimBrief username | On load, imports that user's latest flight plan as a real route |
| `lang`    | `zh`, `en` | Place-label language |
| `base`    | `vector`, `satellite` | Basemap mode |
| `globe`   | `1` | `1` renders the map as a 3D globe at low zoom; omit for the flat map |
| `terrain` | `1` | `1` enables 3D terrain relief; omit for the flat surface |
| `u`       | `km`, `mi`, `nm` | Distance unit |
| `labels`  | `0` | `0` hides place labels; omit to show them |
| `theme`   | `light` | `light` uses the light UI theme; omit for dark mode |

Example: `/?route=LHR-SIN-SYD;PEK-JFK&base=satellite&u=nm`

## Airport data

`src/data/airports.json` is generated from the [OurAirports](https://ourairports.com/data/)
database (large/medium/small airports carrying an IATA code, plus large airports that have only
an ICAO code, including an elevation field used by the airport card) and is committed to this
repository, so a fresh checkout works without regenerating it.

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
│   ├── components/             # search panel, route list, route summary, flight log, favorites, airport card, top-right controls
│   ├── state/saved.ts          # local persistence: draft / favorites / flight log (localStorage)
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
- **Terrain hillshade & 3D terrain** — AWS Open Data Terrain Tiles (Mapzen).
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
