// 3D 地球太空场景：程序化星空 + 地球边缘大气辉光（自绘 2D canvas，零依赖零资产文件）。
// 观感基准是 Google Earth：太空近黑、星星低调，让地球当主角；大气 = 贴边白亮带 +
// 窄蓝光圈快速衰减 + 球面内侧深蓝吸收带过渡。
//
// 两个已实测前提（HANDOFF §4「3D 地球批 2」）：maplibre v5.24 自带大气 shader 不渲染
// （setSky / 样式级 sky 均无效，勿再追查）；球外 WebGL 画布像素全透明。
// 因此星空画布垫在地图画布之下、辉光画布盖在地图画布之上（地图控件之下），互不干扰。
//
// 辉光几何（2026-10-09 重做）：球心 = project(地图中心)，半径 = 球盘轮廓的解析解 ——
// globe 是透视投影，屏幕上球面点 to |project(θ)-球心| 在地平线角处取到最大值，这个
// 最大值就是轮廓半径（ternary search 求极值，只调 project()，不读像素）。
// 不再逐帧扫描 WebGL 画布：交互期间 limb 像素天然不可靠——地名标注/白晕会凸出轮廓
// （实测偏大 +25px），瓦片交叉淡入淡出又会把边缘掏空（实测偏小 -15px），「取 max + EMA
// 偏差>8px 瞬跳」把这些污染逐帧放大成辉光亮边的来回弹跳（用户报告的拖动抽搐）。
// 解析半径是相机的纯函数：拖动（zoom 不变）时严格恒定，缩放时逐帧精确跟随，零抖动。

import type { Map as MLMap } from 'maplibre-gl';
import { destinationPoint } from '../geo/greatCircle';

/** 球心到边缘角距 90° 对应的地面距离 = 地球周长的 1/4 */
const QUARTER_CIRCUMFERENCE_KM = 40075.017 / 4;

export interface SpaceScene {
  destroy(): void;
}

/** 固定种子伪随机：星空图案可复现，重绘不闪变 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type StarTint = '255,255,255' | '214,228,255' | '255,238,214' | '235,242,255';

function drawStarDot(
  ctx: CanvasRenderingContext2D, x: number, y: number, r: number, alpha: number, tint: StarTint,
): void {
  ctx.fillStyle = `rgba(${tint},${alpha.toFixed(3)})`;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
}

/** 最亮一档的星：小光晕 + 极细衍射十字 + 核心（整体压得很低，太空保持安静） */
function drawBrightStar(
  ctx: CanvasRenderingContext2D, x: number, y: number, r: number, alpha: number, tint: StarTint,
): void {
  const glowR = r * 4.5;
  const g = ctx.createRadialGradient(x, y, 0, x, y, glowR);
  g.addColorStop(0, `rgba(${tint},${(alpha * 0.55).toFixed(3)})`);
  g.addColorStop(0.25, `rgba(${tint},${(alpha * 0.18).toFixed(3)})`);
  g.addColorStop(1, `rgba(${tint},0)`);
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(x, y, glowR, 0, Math.PI * 2);
  ctx.fill();

  ctx.strokeStyle = `rgba(${tint},${(alpha * 0.12).toFixed(3)})`;
  ctx.lineWidth = 0.7;
  ctx.beginPath();
  ctx.moveTo(x - r * 2.6, y);
  ctx.lineTo(x + r * 2.6, y);
  ctx.moveTo(x, y - r * 2.6);
  ctx.lineTo(x, y + r * 2.6);
  ctx.stroke();

  drawStarDot(ctx, x, y, r * 0.8, Math.min(1, alpha + 0.1), tint);
}

/** 星空：近黑深空里的细碎星点 + 几乎察觉不到的银河冷光带。
 *  有意不加彩色星云/暗角（Google Earth 的太空是纯陪衬，抢戏的装饰都会显廉价） */
function drawStarfield(canvas: HTMLCanvasElement, w: number, h: number, dpr: number): void {
  const ctx = canvas.getContext('2d');
  if (!ctx || w === 0 || h === 0) return;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const rnd = mulberry32(0x6c6d61);
  const area = w * h;

  ctx.save();
  ctx.translate(w * 0.58, h * 0.34);
  ctx.rotate(-0.46);
  const bw = Math.max(w, h) * 1.5;
  const bh = Math.min(w, h) * 0.5;
  const band = ctx.createLinearGradient(0, -bh / 2, 0, bh / 2);
  band.addColorStop(0, 'rgba(160,185,235,0)');
  band.addColorStop(0.5, 'rgba(160,185,235,0.024)');
  band.addColorStop(1, 'rgba(160,185,235,0)');
  ctx.fillStyle = band;
  ctx.fillRect(-bw / 2, -bh / 2, bw, bh);
  const bandStars = Math.round(area / 4200);
  for (let i = 0; i < bandStars; i++) {
    const x = (rnd() - 0.5) * bw;
    const y = (rnd() - 0.5) * bh * 0.55 * (rnd() + rnd());
    drawStarDot(ctx, x, y, 0.3 + rnd() * 0.4, 0.04 + rnd() * 0.13, '235,242,255');
  }
  ctx.restore();

  const pickTint = (): StarTint => {
    const t = rnd();
    return t < 0.66 ? '255,255,255' : t < 0.86 ? '214,228,255' : '255,238,214';
  };
  const dust = Math.round(area / 4200);
  for (let i = 0; i < dust; i++) {
    drawStarDot(ctx, rnd() * w, rnd() * h, 0.3 + rnd() * 0.35, 0.05 + rnd() * 0.12, pickTint());
  }
  const main = Math.round(area / 13000);
  for (let i = 0; i < main; i++) {
    drawStarDot(ctx, rnd() * w, rnd() * h, 0.5 + rnd() * 0.5, 0.14 + rnd() * 0.24, pickTint());
  }
  const bright = Math.round(area / 55000);
  for (let i = 0; i < bright; i++) {
    drawBrightStar(ctx, rnd() * w, rnd() * h, 0.7 + rnd() * 0.7, 0.35 + rnd() * 0.25, pickTint());
  }
}

/** 球盘轮廓解析解：屏幕上球面点 |project(θ)-球心| 的最大值（θ=沿大圆的角距），
 *  即透视投影的地平线切锥在屏幕上的半径。rAt 在地平线角处单峰，ternary search 收敛。
 *  返回 null = 当前没有可画的球体（mercator 回落/球过大过小/投影异常）。
 *  实测（z0.3–z3.4，对照 WebGL 画布轮廓）：与像素真值差 <1.5%（AA 边缘宽度量级） */
function limbGeometry(map: MLMap, maxR: number): { cx: number; cy: number; r: number } | null {
  const c = map.getCenter();
  const center = map.project([c.lng, c.lat]);
  if (!Number.isFinite(center.x) || !Number.isFinite(center.y)) return null;
  const rAt = (arcDeg: number): number => {
    const p = map.project(destinationPoint({ lon: c.lng, lat: c.lat }, 90, QUARTER_CIRCUMFERENCE_KM * (arcDeg / 90)));
    return Math.hypot(p.x - center.x, p.y - center.y);
  };
  let lo = 2;
  let hi = 178;
  for (let i = 0; i < 40; i++) {
    const m1 = lo + (hi - lo) / 3;
    const m2 = hi - (hi - lo) / 3;
    if (rAt(m1) < rAt(m2)) lo = m1;
    else hi = m2;
  }
  const r = rAt((lo + hi) / 2);
  if (!Number.isFinite(r) || r < 8 || r > maxR * 1.3) return null;
  return { cx: center.x, cy: center.y, r };
}

/** 大气辉光。返回 false = 当前没有可见球体，画布保持全透明 */
function drawAtmosphere(map: MLMap, canvas: HTMLCanvasElement): boolean {
  const ctx = canvas.getContext('2d');
  if (!ctx) return false;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const geom = limbGeometry(map, Math.max(canvas.width, canvas.height));
  if (!geom) return false;
  const r = geom.r;
  const w = canvas.width;
  const h = canvas.height;
  const cx = geom.cx;
  const cy = geom.cy;

  // 1) 球面内侧贴边的大气（clip 在盘内）：微暗 → 深蓝吸收带 → 快速爬升到贴边白亮带。
  //    径向渐变超出外圈会钳到末档颜色，必须 clip 再填
  const inner = ctx.createRadialGradient(cx, cy, r * 0.8, cx, cy, r);
  inner.addColorStop(0, 'rgba(8,20,45,0)');
  inner.addColorStop(0.5, 'rgba(12,30,66,0.12)');
  inner.addColorStop(0.78, 'rgba(18,44,96,0.18)');
  inner.addColorStop(0.9, 'rgba(90,140,225,0.28)');
  inner.addColorStop(0.97, 'rgba(185,215,252,0.55)');
  inner.addColorStop(1, 'rgba(235,245,255,0.82)');
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, r - 0.5, 0, Math.PI * 2);
  ctx.clip();
  ctx.fillStyle = inner;
  ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
  ctx.restore();

  // 2) 边缘外圈光圈：贴轮廓的白亮环 ~10% 半径内衰减完（Google 的光圈收得很紧）。
  //    渐变从 0.85R、alpha 0 起步 —— 内侧会钳位到首档颜色，首档 nonzero 会把整球蒙上白雾
  const glow = ctx.createRadialGradient(cx, cy, r * 0.85, cx, cy, r * 1.1);
  glow.addColorStop(0, 'rgba(216,238,255,0)');
  glow.addColorStop(0.52, 'rgba(200,230,255,0.10)');
  glow.addColorStop(0.6, 'rgba(216,238,255,0.60)');
  glow.addColorStop(0.68, 'rgba(180,215,255,0.42)');
  glow.addColorStop(0.8, 'rgba(115,165,245,0.18)');
  glow.addColorStop(0.9, 'rgba(75,120,228,0.06)');
  glow.addColorStop(1, 'rgba(50,88,190,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, w, h);

  // 3) 细亮边线：把球体轮廓从星空里“提”出来
  ctx.strokeStyle = 'rgba(235,246,255,0.55)';
  ctx.lineWidth = Math.max(1, r * 0.0022);
  ctx.beginPath();
  ctx.arc(cx, cy, r - ctx.lineWidth * 0.4, 0, Math.PI * 2);
  ctx.stroke();

  return true;
}

/** 挂载太空场景（仅 globe 模式调用；返回 destroy 供切回 mercator 时整体卸载） */
export function mountSpaceScene(map: MLMap): SpaceScene {
  const container = map.getContainer();

  const stars = document.createElement('canvas');
  stars.className = 'space-stars';
  const atmo = document.createElement('canvas');
  atmo.className = 'space-atmo';
  for (const el of [stars, atmo]) {
    Object.assign(el.style, {
      position: 'absolute',
      inset: '0',
      width: '100%',
      height: '100%',
      pointerEvents: 'none',
    });
  }
  atmo.style.opacity = '0';
  atmo.style.transition = 'opacity 0.6s ease';

  // 星空垫底（canvas-container 之前）；辉光盖在地图画布上、控件（署名/导航）之下
  container.insertBefore(stars, container.firstChild);
  map.getCanvasContainer().insertAdjacentElement('afterend', atmo);

  // 辉光按 1 倍分辨率绘制省填充开销；半径是解析解，无需离屏画布和逐帧读像素
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const sizeStars = () => {
    drawStarfield(stars, container.clientWidth, container.clientHeight, dpr);
  };
  atmo.width = Math.max(1, container.clientWidth);
  atmo.height = Math.max(1, container.clientHeight);
  sizeStars();

  let lastKey = '';
  const drawAtmoFrame = () => {
    const z = map.getZoom();
    const c = map.getCenter();
    // 中心/缩放/画布尺寸都没变就跳过（纯旋转时球盘不变）；投影切换由专属事件强制重画
    const key = `${z.toFixed(3)}|${c.lng.toFixed(4)}|${c.lat.toFixed(4)}|${atmo.width}x${atmo.height}`;
    if (key === lastKey) return;
    lastKey = key;
    drawAtmosphere(map, atmo);
  };
  const onRender = () => drawAtmoFrame();
  const onResize = () => {
    sizeStars();
    atmo.width = Math.max(1, container.clientWidth);
    atmo.height = Math.max(1, container.clientHeight);
    lastKey = '';
    drawAtmoFrame();
  };
  const onProjectionChange = () => {
    lastKey = '';
    drawAtmoFrame();
  };
  map.on('render', onRender);
  map.on('resize', onResize);
  map.on('projectiontransition', onProjectionChange);
  drawAtmoFrame();

  requestAnimationFrame(() => {
    drawAtmoFrame();
    atmo.style.opacity = '1';
  });

  // 星空整体极缓慢的透明度呼吸，避免完全静止的死板感
  let breathe: Animation | undefined;
  if (typeof stars.animate === 'function') {
    breathe = stars.animate(
      [{ opacity: '1' }, { opacity: '0.9' }],
      { duration: 6800, direction: 'alternate', iterations: Infinity, easing: 'ease-in-out' },
    );
  }

  return {
    destroy(): void {
      map.off('render', onRender);
      map.off('resize', onResize);
      map.off('projectiontransition', onProjectionChange);
      breathe?.cancel();
      stars.remove();
      atmo.remove();
    },
  };
}
