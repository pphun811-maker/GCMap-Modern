# GCMap Modern

GCMap Modern is a browser-based great-circle route mapper. Airport codes are assembled into one
or more routes; the application draws the great-circle path between consecutive airports on an
Apple Maps-style map and reports the distance and initial bearing of every leg, along with the
route total in kilometres, statute miles, or nautical miles.

English | [简体中文](README.zh-CN.md)

## Features

- **Dual basemaps:** A vector basemap in an Apple Maps-inspired palette, with global landcover
  imagery underneath, terrain hillshade, and ground-use coloring; plus an Esri World Imagery
  satellite mode. Place labels stay readable in both modes.
- **Multiple routes:** Routes are managed in a list; each has independent visibility, color,
  and line width, and new routes are assigned colors automatically.
- **Great-circle geometry:** Per-leg distance and initial bearing, route totals, and
  km / mi / nm conversion. Routes crossing the antimeridian are drawn continuously.
- **Bilingual place labels:** Map labels switch between Simplified Chinese and English, and can
  be hidden entirely.
- **Airport search:** 8,799 airports from the OurAirports database, searchable by IATA/ICAO
  code or by name.
- **Two input modes:** A tag-flow input for interactive composition, and a raw-text mode that
  accepts several routes pasted at once.
- **URL deep links:** Routes, language, basemap, unit, and label visibility are all encoded in
  the URL and restored on load.

## Getting started

Requirements: Node.js 20.19+ or 22.12+ (per Vite 8) and npm.

```bash
npm install
npm run dev
```

The development server runs at http://127.0.0.1:5173.

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
| `lang`    | `zh`, `en` | Place-label language |
| `base`    | `vector`, `satellite` | Basemap mode |
| `u`       | `km`, `mi`, `nm` | Distance unit |
| `labels`  | `0` | `0` hides place labels; omit to show them |

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
│   └── map/
│       ├── styleFactory.ts     # adapts the generated style: layer groups, satellite layer, labels
│       └── MapController.ts    # MapLibre wrapper: layers, markers, basemap switching
├── design-assets/              # generated style and landcover assets consumed by the build
└── scripts/build-airports.mjs  # OurAirports CSV -> src/data/airports.json
```

## Data sources and attribution

The application renders third-party map data. The attribution control in the lower-right corner
of the map carries these credits; per the respective licenses, it must not be removed.

- **Vector tiles and place names** — served by OpenFreeMap; underlying map data
  © OpenStreetMap contributors (ODbL).
- **Vector basemap style** — generated for this project; landcover and ground-use colors are
  derived from OSM Carto (CC0).
- **Land cover base imagery** — NASA EOSDIS GIBS, restyled for this project.
- **Terrain hillshade** — AWS Open Data Terrain Tiles (Mapzen).
- **Satellite imagery** — Esri World Imagery (Esri, Maxar, Earthstar Geographics).
- **Airport database** — OurAirports.com (public domain).
- **Typeface** — Inter (SIL Open Font License).

## License

The source code is released under the [MIT License](LICENSE). The map data, imagery, and the
airport database listed above remain subject to their own licenses and attribution
requirements.
