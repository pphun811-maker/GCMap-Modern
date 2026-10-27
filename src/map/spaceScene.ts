// 3D 地球太空背景：demo（round-11 候选 app.js）的确定性细星点风格。
//
// 参考源：`stars()` —— 背景 #030912（见 app.css 的 .map-root）、固定种子 31057、
// 430 个低亮度星点（5% 半径 1.2，其余 0.55；颜色 rgba(180,207,227, .12–.54)），
// 画布 DPR 上限 1.5。星点随机序列由种子决定，重绘/窗口尺寸变化不会闪变。
//
// 设计约束：
//   - 只作用于地图区域，画布垫在地图画布之下，pointer-events:none，不遮挡面板/标注；
//   - 只在 globe 模式挂载，切平面/销毁时整体卸载；
//   - 只在尺寸变化时重绘，不做逐帧渲染；
//   - 大气辉光归行星层（planet.frag 的 halo/haze）；这里不再画第二圈 CSS 光晕。

import type { Map as MLMap } from 'maplibre-gl';

export interface SpaceScene {
  destroy(): void;
}

const STAR_SEED = 31057;
const STAR_COUNT = 430;
const STAR_MAX_DPR = 1.5;
const STAR_COLOR = '180,207,227';

/** demo 的 LCG（16807 乘子）；同一 seed 序列可复现 */
function demoRandom(seedStart: number): () => number {
  let seed = seedStart;
  return () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
}

function drawStarfield(canvas: HTMLCanvasElement, width: number, height: number): void {
  const ctx = canvas.getContext('2d');
  if (!ctx || width <= 0 || height <= 0) return;
  const ratio = Math.min(window.devicePixelRatio || 1, STAR_MAX_DPR);
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, width, height);

  const random = demoRandom(STAR_SEED);
  for (let i = 0; i < STAR_COUNT; i++) {
    const x = random() * width;
    const y = random() * height;
    const r = random() > 0.97 ? 1.2 : 0.55;
    const alpha = 0.12 + random() * 0.42;
    ctx.fillStyle = `rgba(${STAR_COLOR},${alpha.toFixed(3)})`;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
}

/** 挂载太空背景（仅 globe 模式调用；返回 destroy 供切回 mercator 时整体卸载） */
export function mountSpaceScene(map: MLMap): SpaceScene {
  const container = map.getContainer();
  const stars = document.createElement('canvas');
  stars.className = 'space-stars';
  Object.assign(stars.style, {
    position: 'absolute',
    inset: '0',
    width: '100%',
    height: '100%',
    pointerEvents: 'none',
  });
  // 最底层：地图画布球外像素透明，星点从球背后透出；App 面板在 map-root 之上，不受影响
  container.insertBefore(stars, container.firstChild);

  const sizeStars = () => {
    drawStarfield(stars, container.clientWidth, container.clientHeight);
  };
  sizeStars();

  const onResize = () => sizeStars();
  map.on('resize', onResize);

  return {
    destroy(): void {
      map.off('resize', onResize);
      stars.remove();
    },
  };
}
