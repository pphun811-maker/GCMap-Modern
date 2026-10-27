// CI opts into a browser-only resource path; local dev retains the Node middleware.
export const STATIC_MAP = import.meta.env.VITE_STATIC_MAP === '1';
export function staticAssetUrl(path: string): string {
  const base = import.meta.env.BASE_URL || '/';
  const page = typeof location !== 'undefined' ? location.href : 'http://localhost/';
  return new URL(`${base}map-static/${path}`, page).href.replace(/%7B/gi, '{').replace(/%7D/gi, '}');
}
export function staticResourceUrl(path: string): string {
  if (path.startsWith('tiles/')) return `flmap://${path.slice(6)}`;
  if (path === 'snow-support/meta.json' || path === 'snow-support/bin') return staticAssetUrl(path);
  return staticAssetUrl(path.replace('fonts/{fontstack}/', 'fonts/{fontstack}/'));
}
export async function fetchMapResource(url: string, signal: AbortSignal): Promise<Response> {
  if (STATIC_MAP && url.includes('roads.geojson')) {
    const {fetchStaticRoads} = await import('./staticRoadClient');
    return fetchStaticRoads(url, signal);
  }
  return fetch(url, {signal});
}
