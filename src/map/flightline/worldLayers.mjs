// Source-layers the MapLibre styles actually draw from the `world` source.
// Everything else in a protomaps near tile (pois, transit, natural, ...) never
// reaches a bucket, so the Node server and the static client both drop it
// before it is transferred and decoded.
//
// Keep this in sync with the style JSON; test-static-map asserts that this set
// equals the world source-layers referenced by styles/dark.json and
// styles/light.json.
export const WORLD_TILE_LAYERS = new Set([
  'earth',
  'landcover',
  'landuse',
  'roads',
  'water',
  'boundaries',
  'buildings',
  'places',
]);
