// 卫星瓦片逐像素海洋调色（gcimg:// 自定义协议）：Stadia 纯影像的深海实测 ≈ RGB(3,11,15) 近黑且几乎无色，
// MapLibre 的全局 raster paint 属性数学上补不出 Google Maps 的饱和藏蓝（RGB(35,52,102)）——
// 近黑像素没有色彩可提。因此瓦片抓回后在浏览器里逐像素处理再交给渲染。
// 参数为 2026-10-06 用户在 demo 中调参定稿，勿再调（HANDOFF.md §7.5）。

import { addProtocol } from 'maplibre-gl';

export const OCEAN_CFG = {
  thrLow: 0.075, thrHigh: 0.185,      // 亮度判海陆：小于前者判海、大于后者判陆，中间平滑过渡（海岸线无硬边）
  navy: [0.137, 0.204, 0.400],        // Google 深海目标色 RGB(35,52,102)
  shadeLo: 0.72, shadeHi: 1.20,       // 深海→浅滩的明度渐变
  landLift: 0.012, landGain: 1.04, landSat: 0.90,  // 陆地：略降饱和 + 轻微提亮
};

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (a: number, b: number, v: number) => {
  const t = clamp01((v - a) / (b - a));
  return t * t * (3 - 2 * t);
};

/** 就地处理 RGBA 像素：①亮度+植被判据算海陆权重 ②海洋=藏蓝×深浅渐变 ③陆地=提亮+饱和，按权重混合 */
export function processTile(d: Uint8ClampedArray): void {
  const C = OCEAN_CFG;
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i] / 255, g = d[i + 1] / 255, b = d[i + 2] / 255;
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    // 海陆判据：亮度为主；植被（绿>蓝）强制判陆，避免雨林被染蓝
    let land = smooth(C.thrLow, C.thrHigh, lum);
    const veg = g - b;
    if (veg > 0.015) land = Math.max(land, smooth(0.015, 0.06, veg));
    // 陆地：降饱和（向亮度收拢）后叠加提亮的原色
    const ss = C.landSat;
    const lr = clamp01(lum * (1 - ss) + (r * C.landGain + C.landLift) * ss);
    const lg = clamp01(lum * (1 - ss) + (g * C.landGain + C.landLift) * ss);
    const lb = clamp01(lum * (1 - ss) + (b * C.landGain + C.landLift) * ss);
    // 海洋：按原亮度做深浅渐变的藏蓝
    const t = clamp01(lum / C.thrHigh);
    const shade = C.shadeLo + (C.shadeHi - C.shadeLo) * t;
    d[i]     = 255 * clamp01(lr * land + C.navy[0] * shade * (1 - land));
    d[i + 1] = 255 * clamp01(lg * land + C.navy[1] * shade * (1 - land));
    d[i + 2] = 255 * clamp01(lb * land + C.navy[2] * shade * (1 - land));
  }
}

let protocolRegistered = false;

/**
 * 注册 gcimg:// 自定义协议（抓 Stadia EU 端点影像 → processTile → 回传 PNG）。
 * 必须在 new MLMap() 之前调用，否则首批瓦片会请求未注册的协议。
 * 协议 URL 容忍 ?v=<n> 后缀：处理参数若有变更，版本号自增后经 source.setTiles 穿透瓦片缓存。
 */
export function ensureProtocol(getKey: () => string): void {
  if (protocolRegistered) return;
  protocolRegistered = true;
  addProtocol('gcimg', async (params) => {
    const m = params.url.match(/^gcimg:\/\/(\d+)\/(\d+)\/(\d+)(?:\?.*)?$/);
    if (!m) throw new Error(`bad gcimg url: ${params.url}`);
    const real = `https://tiles-eu.stadiamaps.com/data/imagery/${m[1]}/${m[2]}/${m[3]}.jpg?api_key=${getKey()}`;
    const resp = await fetch(real);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}（Stadia ${m[1]}/${m[2]}/${m[3]}）`);
    const bmp = await createImageBitmap(await resp.blob());
    const cv = new OffscreenCanvas(bmp.width, bmp.height);
    const cx = cv.getContext('2d');
    if (!cx) throw new Error('OffscreenCanvas 2d context unavailable');
    cx.drawImage(bmp, 0, 0);
    const img = cx.getImageData(0, 0, bmp.width, bmp.height);
    processTile(img.data);
    cx.putImageData(img, 0, 0);
    const blob = await cv.convertToBlob({ type: 'image/png' });
    return { data: await blob.arrayBuffer() };
  });
}
