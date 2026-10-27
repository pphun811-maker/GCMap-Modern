// MapLibre 5.24 在低缩放 globe 下用相机 zoom 为整球选同一级瓦片。
// 拖向极点时相机 zoom 会随 cos(latitude) 降低，球体屏幕大小却不变，
// 导致大陆也退回 z0/z1。只在高纬低缩放时补偿 raster 的选片尺寸。
// tileSize 是 Source 的公开可写字段，只影响选片，不改 XYZ 坐标或纹理像素。
export function satelliteTileSize(
  configuredSize: number,
  latitude: number,
  zoom: number,
  globe: boolean,
): number {
  if (!globe || Math.abs(latitude) <= 60) return configuredSize;
  const cosLat = Math.cos(Math.min(85.051129, Math.abs(latitude)) * Math.PI / 180);
  const latitudeBoost = Math.log2(0.5 / cosLat);
  // 不把全球影像一律升到高层级；补偿后的目标层级最多 z4。
  // 原来已高于 z4 时沿用引擎的按距离选片，平面/近景完全恢复原尺寸。
  const sourceZoom = zoom + Math.log2(512 / configuredSize);
  const boost = Math.max(0, Math.min(latitudeBoost, 4 - sourceZoom));
  return configuredSize / 2 ** boost;
}
