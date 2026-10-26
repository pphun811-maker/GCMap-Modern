// 卫星瓦片色彩管线（gsat:// 自定义协议）：抓 MapTiler satellite-v2 影像 →
// 只做陆地色彩处理（白平衡/去饱和/亮度/对比度/高光白色/沙漠 HSL 分区）→ 回传 PNG。
// 海面不再逐像素判色——2026-10-26 起（MapTiler 换源）深色森林/阴影会落进海洋亮度区间
// 被误染成藏蓝（北欧泰加林、亚马逊"水坑"+瓦片拼接矩形补丁实测实锤），水体改由
// styleFactory 注入的矢量水面层（OpenFreeMap water 多边形）负责，本文件不再含海洋分支。
//
// 参数为 2026-10-26 用户在对比 demo 中调参定稿（陆地组+沙漠组），勿再调。

import { addProtocol } from 'maplibre-gl';

const TINT = {
  landSat: 0.89,
  landGamma: 1.34,
  landContrast: 1.44,
  highlights: -0.02,
  whites: -0.15,
  landGain: 0.995,
  landLift: 0.012, // 结构参数：与旧 Stadia 定稿一致
  rGain: 0.93,
  gGain: 1.03,
  bGain: 1.12,
  desCenter: 9, // 沙漠色带中心（度）：用户定稿偏向红橙
  desWidth: 41, // 色带半宽（度），带外 25° 平滑衰减
  desHue: -1,
  desSat: 0.88, // 2026-10-26 二次定稿：1.32 会把澳洲红土/非洲之角推成火红，回落到 0.88
  desLum: -0.07,
};

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (a: number, b: number, v: number) => {
  const t = clamp01((v - a) / (b - a));
  return t * t * (3 - 2 * t);
};

function hsl2rgb(h: number, s: number, l: number): [number, number, number] {
  h = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const table = [
    [c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x],
  ] as const;
  return [table[h / 60 | 0][0] + m, table[h / 60 | 0][1] + m, table[h / 60 | 0][2] + m];
}

/** 就地处理 RGBA 像素：陆地色彩管线（无海陆判据，全像素一致处理） */
export function processTile(d: Uint8ClampedArray): void {
  const P = TINT;
  for (let i = 0; i < d.length; i += 4) {
    let r = clamp01((d[i] / 255) * P.rGain);
    let g = clamp01((d[i + 1] / 255) * P.gGain);
    let b = clamp01((d[i + 2] / 255) * P.bGain);
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const ss = P.landSat;
    let lr = clamp01(lum * (1 - ss) + (r * P.landGain + P.landLift) * ss);
    let lg = clamp01(lum * (1 - ss) + (g * P.landGain + P.landLift) * ss);
    let lb = clamp01(lum * (1 - ss) + (b * P.landGain + P.landLift) * ss);
    if (P.landGamma !== 1) {
      const ge = 1 / P.landGamma;
      lr = clamp01(Math.pow(lr, ge));
      lg = clamp01(Math.pow(lg, ge));
      lb = clamp01(Math.pow(lb, ge));
    }
    if (P.landContrast !== 1) {
      lr = clamp01(0.5 + (lr - 0.5) * P.landContrast);
      lg = clamp01(0.5 + (lg - 0.5) * P.landContrast);
      lb = clamp01(0.5 + (lb - 0.5) * P.landContrast);
    }
    if (P.highlights !== 0) {
      lr = clamp01(lr + P.highlights * smooth(0.35, 0.9, lr));
      lg = clamp01(lg + P.highlights * smooth(0.35, 0.9, lg));
      lb = clamp01(lb + P.highlights * smooth(0.35, 0.9, lb));
    }
    if (P.whites !== 0) {
      lr = clamp01(lr + P.whites * lr * lr * lr);
      lg = clamp01(lg + P.whites * lg * lg * lg);
      lb = clamp01(lb + P.whites * lb * lb * lb);
    }
    // 沙漠（暖色带）HSL 分区：色带内按权重混入变换结果，低饱和中性色不参与
    if (P.desHue !== 0 || P.desSat !== 1 || P.desLum !== 0) {
      const mx = Math.max(lr, lg, lb);
      const mn = Math.min(lr, lg, lb);
      const dch = mx - mn;
      if (dch > 1e-4) {
        let h: number;
        if (mx === lr) h = ((lg - lb) / dch) % 6;
        else if (mx === lg) h = (lb - lr) / dch + 2;
        else h = (lr - lg) / dch + 4;
        h = (h * 60 + 360) % 360;
        const l = (mx + mn) / 2;
        const s = dch / (1 - Math.abs(2 * l - 1) || 1e-4);
        const dh = Math.abs(((h - P.desCenter + 540) % 360) - 180);
        let w = dh <= P.desWidth ? 1 : clamp01(1 - (dh - P.desWidth) / 25);
        w *= smooth(0.04, 0.12, s);
        if (w > 0) {
          const conv = hsl2rgb(h + P.desHue, clamp01(s * P.desSat), clamp01(l + P.desLum));
          lr += (conv[0] - lr) * w;
          lg += (conv[1] - lg) * w;
          lb += (conv[2] - lb) * w;
        }
      }
    }
    d[i] = 255 * lr;
    d[i + 1] = 255 * lg;
    d[i + 2] = 255 * lb;
  }
}

let protocolRegistered = false;

/**
 * 注册 gsat:// 自定义协议（抓 MapTiler satellite-v2 影像 → 陆地色彩管线 → 回 PNG）。
 * 必须在 new MLMap() 之前调用，否则首批瓦片会请求未注册的协议。
 * 协议 URL 容忍 ?v=<n> 后缀：换 key 时版本号自增经 source.setTiles 穿透瓦片缓存。
 */
export function ensureProtocol(getKey: () => string): void {
  if (protocolRegistered) return;
  protocolRegistered = true;
  addProtocol('gsat', async (params) => {
    const m = params.url.match(/^gsat:\/\/(\d+)\/(\d+)\/(\d+)(?:\?.*)?$/);
    if (!m) throw new Error(`bad gsat url: ${params.url}`);
    const real = `https://api.maptiler.com/tiles/satellite-v2/${m[1]}/${m[2]}/${m[3]}.jpg?key=${encodeURIComponent(getKey())}`;
    const resp = await fetch(real);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}（MapTiler ${m[1]}/${m[2]}/${m[3]}）`);
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
