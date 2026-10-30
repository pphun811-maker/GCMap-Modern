// Flightline 地球光照/地表层（MapLibre WebGL2 custom layer）。
//
// 来源：已验收候选 round-11 的 planet.js（Round 03/05/09 成果）。主项目只保留
// 已验收的一条效果链（round03.frag + material.glsl + 从 flglobe.dll 复原的 R2 终止线 LUT），
// 不搬入 demo 的 Round 02 / R1 / 起始 demo 对照开关与调参面板。
//
// 保留的观感：
//   - 终止线 LUT + 金色时刻叠色、地表材质、海洋 PBR/反光、轨道浮雕、轨道暗化；
//   - 城市灯网（双三次平滑、闪烁、bloom）、雪/冰盖（常年冰雪 + 支撑掩膜）；
//   - atlas 交接按原作两条曲线（Round 12 P1-4）：光晕池与灯点同时乘
//     handoff = 1 - smootherstep(5.25, 8.5, detail)，灯点再额外乘
//     mix(1, LIGHTS_UNDER_ROADS, smoothstep(3.5, 5.5, detail))；
//     稀疏低模路网可见时（u_road_fallback=1）atlas 再乘 FALLBACK_ATLAS_GAIN；
//   - 8K 灯图懒加载（settlement_lights_v1_hi，失败保留 4K 底图）；
//   - 大气边缘辉光（globe 模式；平面模式为 0）。
//
// 依赖适配：不依赖 demo 的全局 glMatrix / 根路径 fetch——矩阵求逆在本文件实现，
// 纹理与冰雪支撑掩膜走主项目 /map-res/ 同源资源接口。
import type { Map as MLMap } from 'maplibre-gl';
import { mapResourceUrl } from '../styleFactory';
import { dayNightUniforms } from '../dayNight';

// Round 12 P2 follow-up：高分灯图在地图首次绘制后于后台加载（与缩放、夜路数据无关），
// 以便“路网到达前”的近景首帧也能用上。requestIdleCallback 在首帧空闲时触发，
// timeout 给连续渲染下的等待设上限；没有 rIC 时退回同量级的定时器。
const HI_ATLAS_NAME = 'settlement_lights_v1_hi.png';
/** 8K 灯图开关：资源与白名单未就位（见 scheduleHiAtlas 的说明），主项目先关。 */
const HI_ATLAS_ENABLED = false;
const HI_ATLAS_IDLE_TIMEOUT_MS = 800;
const HI_ATLAS_FALLBACK_DELAY_MS = 600;
// log2(sqrt(10)/3)：flglobe::tiles::tile_zoom（VA 0x180272120）在相机正下方瓦片上的
// 精确值减相机 zoom（round-12-deep-re/reports/DETAIL-ZOOM-REPORT.md §5）。
const DETAIL_ZOOM_OFFSET = 0.076001546722525;

/** 灯图（texture unit 0）的上传尺寸与诊断信息；atlasInfo 同时记录换图结果。 */
interface AtlasInfo {
  url: string;
  sourceWidth: number;
  sourceHeight: number;
  width: number;
  height: number;
  downscaled: boolean;
  maxTexture: number;
  rgbaBytes: number;
  mipBytes: number;
  state?: 'base' | 'hi';
  uploadedInMs?: number;
  decodeMs?: number;
  hi?: { state: string; error?: string };
}

export interface PlanetState {
  /** 当前可见（vector 底图）；卫星底图关闭整层渲染，保留 GPU 资源避免反复上传 */
  active: boolean;
  /** 昼夜光照开关（demo cycle）：关闭时 u_cycle/u_lights=0，取消昼夜暗化与城市夜光；
   *  地表材质/海洋/冰雪/大气由 u_material/u_atmosphere 保留 */
  cycle: boolean;
  sun: [number, number, number];
  timeDays: number;
  /** 近景夜路权重（NightRoads.handoff()）。Round 12 起 shader 改为原作两条曲线，
   *  不再有 takeover uniform；这两个值仍被记录，供诊断与后续接线使用。 */
  roadHandoff: number;
  /** 中景夜路权重（NightRoads.midHandoff()）；同上，仅记录。 */
  midHandoff: number;
  /** 稀疏低模路网（arterial fallback）是否为当前可见路网 → u_road_fallback。 */
  roadFallback: boolean;
}

export interface PlanetLayerOptions {
  fragment: string;
  material: string;
  onError?: (error: unknown) => void;
  onReady?: () => void;
}

type Mat4 = Float32Array;

/** gl-matrix mat4.invert 的等价实现（避免依赖 demo 全局脚本或新增运行时依赖）。
 *  返回 false 表示奇异矩阵。已对单位阵 / 平移阵 / 透视阵做过单元回归。 */
export function invertMat4(out: Mat4, a: Mat4 | number[]): boolean {
  const a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3];
  const a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7];
  const a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11];
  const a30 = a[12], a31 = a[13], a32 = a[14], a33 = a[15];

  const b00 = a00 * a11 - a01 * a10;
  const b01 = a00 * a12 - a02 * a10;
  const b02 = a00 * a13 - a03 * a10;
  const b03 = a01 * a12 - a02 * a11;
  const b04 = a01 * a13 - a03 * a11;
  const b05 = a02 * a13 - a03 * a12;
  const b06 = a20 * a31 - a21 * a30;
  const b07 = a20 * a32 - a22 * a30;
  const b08 = a20 * a33 - a23 * a30;
  const b09 = a21 * a32 - a22 * a31;
  const b10 = a21 * a33 - a23 * a31;
  const b11 = a22 * a33 - a23 * a32;

  let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (!det) return false;
  det = 1.0 / det;

  out[0] = (a11 * b11 - a12 * b10 + a13 * b09) * det;
  out[1] = (a02 * b10 - a01 * b11 - a03 * b09) * det;
  out[2] = (a31 * b05 - a32 * b04 + a33 * b03) * det;
  out[3] = (a22 * b04 - a21 * b05 - a23 * b03) * det;
  out[4] = (a12 * b08 - a10 * b11 - a13 * b07) * det;
  out[5] = (a00 * b11 - a02 * b08 + a03 * b07) * det;
  out[6] = (a32 * b02 - a30 * b05 - a33 * b01) * det;
  out[7] = (a20 * b05 - a22 * b02 + a23 * b01) * det;
  out[8] = (a10 * b10 - a11 * b08 + a13 * b06) * det;
  out[9] = (a01 * b08 - a00 * b10 - a03 * b06) * det;
  out[10] = (a30 * b04 - a31 * b02 + a33 * b00) * det;
  out[11] = (a21 * b02 - a20 * b04 - a23 * b00) * det;
  out[12] = (a11 * b07 - a10 * b09 - a12 * b06) * det;
  out[13] = (a00 * b09 - a01 * b07 + a02 * b06) * det;
  out[14] = (a31 * b01 - a30 * b03 - a32 * b00) * det;
  out[15] = (a20 * b03 - a21 * b01 + a22 * b00) * det;
  return true;
}

// ---------------------------------------------------------------------------
// 终止线 LUT（Round 02 从 flglobe.dll 复原的 8 个 stop；主项目只用这条已验收曲线）
// ---------------------------------------------------------------------------
export const LUT_STOPS_R2 = [
  { at: -0.35, srgb: [0x00, 0x02, 0x08], alpha: 0.88 },
  { at: -0.21, srgb: [0x01, 0x05, 0x13], alpha: 0.86 },
  { at: -0.105, srgb: [0x0a, 0x16, 0x38], alpha: 0.66 },
  { at: -0.035, srgb: [0x32, 0x2c, 0x46], alpha: 0.40 },
  { at: 0.0, srgb: [0x8f, 0x4a, 0x2e], alpha: 0.20 },
  { at: 0.045, srgb: [0xb0, 0x7a, 0x4a], alpha: 0.07 },
  { at: 0.12, srgb: [0xe8, 0xdc, 0xc0], alpha: 0.02 },
  { at: 0.35, srgb: [0xf2, 0xec, 0xd8], alpha: 0.01 },
];
export const LUT_SIZE_R2 = 256;
const LUT_LO = -0.35, LUT_HI = 0.35;

function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
function linearToSrgb(c: number): number {
  return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

/** 烘焙 256 个预乘 RGBA8 texel：stop 的 sRGB 颜色在线性光里插值再编码回去。 */
export function bakeLutR2(): Uint8Array {
  const data = new Uint8Array(LUT_SIZE_R2 * 4);
  const stops = LUT_STOPS_R2.map((stop) => ({
    at: stop.at,
    lin: stop.srgb.map((c) => srgbToLinear(c / 255)),
    alpha: stop.alpha,
  }));
  for (let i = 0; i < LUT_SIZE_R2; i++) {
    const s = LUT_LO + (LUT_HI - LUT_LO) * i / (LUT_SIZE_R2 - 1);
    let a = stops[0], b = stops[0];
    for (let k = 0; k < stops.length - 1; k++) {
      if (s >= stops[k].at && s <= stops[k + 1].at) { a = stops[k]; b = stops[k + 1]; break; }
    }
    if (s <= stops[0].at) { a = b = stops[0]; }
    if (s >= stops[stops.length - 1].at) { a = b = stops[stops.length - 1]; }
    const span = b.at - a.at;
    const t = span > 0 ? Math.min(1, Math.max(0, (s - a.at) / span)) : 0;
    const alpha = a.alpha + (b.alpha - a.alpha) * t;
    for (let c = 0; c < 3; c++) {
      const lin = a.lin[c] + (b.lin[c] - a.lin[c]) * t;
      data[i * 4 + c] = Math.round(255 * Math.min(1, Math.max(0, linearToSrgb(lin) * alpha)));
    }
    data[i * 4 + 3] = Math.round(255 * Math.min(1, Math.max(0, alpha)));
  }
  return data;
}

function makeLutTexture(gl: WebGL2RenderingContext): WebGLTexture {
  const tex = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, LUT_SIZE_R2, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, bakeLutR2());
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  return tex;
}

const VERTEX_SHADER = `#version 300 es
  in vec2 a_pos; out vec2 v_ndc;
  void main(){ v_ndc=a_pos; gl_Position=vec4(a_pos,0.,1.); }`;

const UNIFORM_NAMES = [
  'u_inverse', 'u_sun', 'u_center', 'u_globe', 'u_zoom', 'u_detail', 'u_cycle',
  'u_lights', 'u_material', 'u_atmosphere', 'u_dark', 'u_compare', 'u_snow',
  'u_time_days', 'u_twinkle', 'u_debug', 'u_elevation_texel', 'u_lights_texel',
  'u_road_fallback',
  't_lights', 't_elevation', 't_material', 't_snow', 't_snow_support', 't_lut',
];

const IMAGE_NAMES = [
  'settlement_lights_v1.png',
  'global_elevation_v1.png',
  'planet_material_v1.png',
  'snow_climatology_v1.png',
];

export class PlanetLayer {
  id = 'planet-lighting';
  type = 'custom';
  renderingMode = '2d';

  private map!: MLMap;
  private program: WebGLProgram | null = null;
  private uniforms: Record<string, WebGLUniformLocation | null> = {};
  private vao: WebGLVertexArrayObject | null = null;
  private buffer: WebGLBuffer | null = null;
  private lut: WebGLTexture | null = null;
  private textures: (WebGLTexture | null)[] = [];
  private sources: TexImageSource[] = [];
  private texelSizes: [number, number][] = [];
  private support: { width: number; height: number; bytes: Uint8Array } | null = null;
  private uploaded = false;
  private ready = false;
  private removed = false;
  private failed = false;
  private maxTexture = 4096;
  /** 灯图上传统计（基础 4K / 高分 8K 的尺寸、降采样、耗时），供诊断与 DEV 日志。 */
  private atlasInfo: AtlasInfo | null = null;
  private hiAtlasState: 'idle' | 'loading' | 'ready' | 'active' | 'failed' | 'disposed' = 'idle';
  /** 已解码、等待 render() 里上传到 texture unit 0 的高分灯图。 */
  private pendingAtlas: { source: TexImageSource; info: AtlasInfo } | null = null;
  private hiAtlasScheduled = false;
  private hiIdleHandle: number | null = null;
  private hiIdleTimer: ReturnType<typeof setTimeout> | null = null;
  private hiAtlasDecodeMs = 0;
  private inverse = new Float32Array(16);
  private state: PlanetState = {
    active: true,
    cycle: true,
    sun: [0, 0, 1],
    timeDays: 0,
    roadHandoff: 0,
    midHandoff: 0,
    roadFallback: false,
  };
  private options: PlanetLayerOptions;

  constructor(options: PlanetLayerOptions) {
    this.options = options;
  }

  onAdd(map: MLMap, gl: WebGL2RenderingContext): void {
    this.map = map;
    this.textures = [];
    this.sources = [];
    this.texelSizes = [];
    const compile = (type: number, src: string): WebGLShader => {
      const shader = gl.createShader(type)!;
      gl.shaderSource(shader, src);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        const log = gl.getShaderInfoLog(shader);
        gl.deleteShader(shader);
        throw Error(log || 'shader compile failed');
      }
      return shader;
    };
    const fragment = this.options.fragment.replace('//__MATERIAL_INCLUDE__', this.options.material);
    const vs = compile(gl.VERTEX_SHADER, VERTEX_SHADER);
    let fs: WebGLShader | null = null;
    try {
      fs = compile(gl.FRAGMENT_SHADER, fragment);
    } catch (e) {
      gl.deleteShader(vs);
      throw e;
    }
    const program = gl.createProgram()!;
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.bindAttribLocation(program, 0, 'a_pos');
    gl.linkProgram(program);
    const linked = gl.getProgramParameter(program, gl.LINK_STATUS);
    const log = linked ? '' : gl.getProgramInfoLog(program);
    gl.detachShader(program, vs);
    gl.detachShader(program, fs);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!linked) {
      gl.deleteProgram(program);
      throw Error(log || 'program link failed');
    }
    this.program = program;
    this.uniforms = Object.fromEntries(
      UNIFORM_NAMES.map((n) => [n, gl.getUniformLocation(program, n)]),
    );

    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    this.buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);

    this.lut = makeLutTexture(gl);
    this.maxTexture = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
    Promise.all([
      ...IMAGE_NAMES.map((name, index) => this.loadImage(name, index)),
      // 冰雪支撑掩膜是可选增强：缺失时只是不画稳定冰雪，不应让整层光照失效。
      this.loadSupport().catch((e) => {
        console.warn('[PlanetLayer] snow support mask unavailable:', String(e?.message ?? e));
      }),
    ]).then(() => {
      if (this.removed) return;
      this.ready = true;
      this.options.onReady?.();
      this.map.triggerRepaint();
    }).catch((e) => {
      // 纹理缺失（例如未配置游戏目录）时地图仍可用：本层保持透明，不阻断业务。
      if (!this.removed && !this.failed) {
        this.failed = true;
        this.options.onError?.(e);
      }
    });
  }

  /** 只在图像超出 cap 时降采样，返回将要上传的 source 与其精确尺寸。
   *  基础纹理保持历史上的 4096 上限（高程 PNG 宽 8192，但一直按 4096 上传）；
   *  只有懒加载的高分灯图把 GPU 的 MAX_TEXTURE_SIZE 当作上限。 */
  private prepareAtlasSource(
    image: HTMLImageElement,
    name: string,
    cap: number,
    warnOnDownscale = false,
  ): { source: TexImageSource; info: AtlasInfo } {
    const downscaled = image.width > cap;
    const width = downscaled ? cap : image.width;
    const height = downscaled
      ? Math.max(1, Math.round(image.height * cap / image.width))
      : image.height;
    let source: TexImageSource = image;
    if (downscaled) {
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      canvas.getContext('2d')!.drawImage(image, 0, 0, width, height);
      source = canvas;
      // 显式请求的高分灯图绝不静默降级；基础纹理保留过去的静默行为。
      if (warnOnDownscale) {
        console.warn(
          `[PlanetLayer] ${name} ${image.width}x${image.height} exceeds the ${cap}px cap ` +
          `(MAX_TEXTURE_SIZE ${this.maxTexture}); uploaded ${width}x${height}`,
        );
      }
    }
    return {
      source,
      info: {
        url: mapResourceUrl(`planet/${name}`),
        sourceWidth: image.width,
        sourceHeight: image.height,
        width,
        height,
        downscaled,
        maxTexture: this.maxTexture,
        rgbaBytes: width * height * 4,
        mipBytes: Math.ceil(width * height * 4 * 4 / 3),
      },
    };
  }

  private async loadImage(name: string, index: number): Promise<void> {
    const image = new Image();
    image.src = mapResourceUrl(`planet/${name}`);
    await image.decode();
    if (this.removed) return;
    const { source, info } = this.prepareAtlasSource(
      image, name, Math.min(4096, this.maxTexture || 4096),
    );
    if (index === 0) {
      // texture unit 0 是城市灯图：实际上传尺寸同时决定 render() 的 u_lights_texel。
      this.atlasInfo = { ...info, state: 'base' };
    }
    this.sources[index] = source;
    this.texelSizes[index] = [1 / info.width, 1 / info.height];
  }

  /** Round 12 P2 follow-up：首帧之后一次性在后台启动 8192x4096 灯图。
   *  requestIdleCallback 先让首帧与地图初始化做完，timeout 给连续渲染下的等待设上限。
   *  解码完成前（以及加载失败时永远）继续渲染 4K 底图，上传在 swapAtlas() 里完成。 */
  private scheduleHiAtlas(): void {
    // 主项目暂不启用 8K 灯图：public/map-static/planet 与服务端白名单（server/
    // mapResources.mjs PLANET_TEXTURES）都只有 4096 底图，线上请求必然 404 并刷
    // 告警；8192² 是 13 MB 游戏派生资源，体积/显存/移动端策略尚未决策
    // （ROUND-12-HANDOFF §8）。要启用需三处同时到位：放文件、加白名单、把这里改 true。
    if (!HI_ATLAS_ENABLED) return;
    if (this.hiAtlasScheduled || this.hiAtlasState !== 'idle' || this.removed) return;
    this.hiAtlasScheduled = true;
    const start = (): void => {
      this.hiIdleHandle = null;
      this.hiIdleTimer = null;
      if (this.removed || this.hiAtlasState !== 'idle') return;
      this.hiAtlasState = 'loading';
      void this.loadHiAtlas();
    };
    if (typeof requestIdleCallback === 'function') {
      this.hiIdleHandle = requestIdleCallback(start, { timeout: HI_ATLAS_IDLE_TIMEOUT_MS });
    } else {
      this.hiIdleTimer = setTimeout(start, HI_ATLAS_FALLBACK_DELAY_MS);
    }
  }

  private cancelScheduledHiAtlas(): void {
    if (this.hiIdleHandle !== null && typeof cancelIdleCallback === 'function') {
      cancelIdleCallback(this.hiIdleHandle);
    }
    if (this.hiIdleTimer !== null) clearTimeout(this.hiIdleTimer);
    this.hiIdleHandle = null;
    this.hiIdleTimer = null;
  }

  /** 一次性加载 8192x4096 灯图；解码完成前继续渲染 4K 底图。失败必须记录并告警。 */
  private async loadHiAtlas(): Promise<void> {
    const started = performance.now();
    try {
      const image = new Image();
      image.src = mapResourceUrl(`planet/${HI_ATLAS_NAME}`);
      await image.decode();
      if (this.removed) { this.hiAtlasState = 'disposed'; return; }
      const { source, info } = this.prepareAtlasSource(
        image, HI_ATLAS_NAME, this.maxTexture || 4096, true,
      );
      this.hiAtlasDecodeMs = Math.round(performance.now() - started);
      this.pendingAtlas = { source, info };
      this.hiAtlasState = 'ready';
      this.map.triggerRepaint();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.hiAtlasState = 'failed';
      if (this.atlasInfo) this.atlasInfo.hi = { state: 'failed', error: message };
      console.warn('[PlanetLayer] settlement lights hi atlas unavailable; keeping the 4096 base:', message);
    }
  }

  /** 把解码好的高分灯图上传到 texture unit 0 并释放底图。在 render() 里调用，
   *  这样 MapLibre 会在我们的 GL 调用之后失效自己的状态缓存（同 uploadTextures）。 */
  private swapAtlas(gl: WebGL2RenderingContext): void {
    if (!this.pendingAtlas) return;
    const { source, info } = this.pendingAtlas;
    this.pendingAtlas = null;
    const keys = [gl.UNPACK_FLIP_Y_WEBGL, gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.UNPACK_ALIGNMENT];
    const previous = keys.map((key) => gl.getParameter(key));
    const started = performance.now();
    let tex: WebGLTexture | null = null;
    try {
      gl.pixelStorei(keys[0], false);
      gl.pixelStorei(keys[1], false);
      gl.pixelStorei(keys[2], gl.NONE);
      tex = gl.createTexture();
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.generateMipmap(gl.TEXTURE_2D);
      const old = this.textures[0];
      this.textures[0] = tex;
      if (old) gl.deleteTexture(old);
      this.texelSizes[0] = [1 / info.width, 1 / info.height];
      this.atlasInfo = {
        ...(this.atlasInfo ?? {}),
        ...info,
        state: 'hi',
        uploadedInMs: Math.round(performance.now() - started),
        decodeMs: this.hiAtlasDecodeMs,
      };
      this.hiAtlasState = 'active';
      if (import.meta.env.DEV) console.info('[PlanetLayer] lights atlas', this.atlasInfo);
    } catch (error) {
      // GL 拒绝上传（例如显存不足）：保留底图并记录确切失败，而不是失去整张灯图。
      if (tex) gl.deleteTexture(tex);
      const message = error instanceof Error ? error.message : String(error);
      this.hiAtlasState = 'failed';
      if (this.atlasInfo) this.atlasInfo.hi = { state: 'failed', error: message };
      console.warn('[PlanetLayer] settlement lights hi atlas upload failed; keeping the 4096 base:', message);
    } finally {
      keys.forEach((key, i) => gl.pixelStorei(key, previous[i]));
    }
  }

  /** 冰川/冰盖支撑掩膜：与雪候补图共用 ±90 网格，一个 texel 一字节（R8 纹理省显存）。
   *  该文件缺失时只是不画稳定冰雪，不影响其余光照。 */
  private async loadSupport(): Promise<void> {
    const [metaResponse, binResponse] = await Promise.all([
      fetch(mapResourceUrl('snow-support/meta.json')),
      fetch(mapResourceUrl('snow-support/bin')),
    ]);
    if (!metaResponse.ok || !binResponse.ok) {
      throw Error(`snow support mask ${metaResponse.status}/${binResponse.status}`);
    }
    const meta = await metaResponse.json();
    const bytes = new Uint8Array(await binResponse.arrayBuffer());
    const { width, height } = meta.output;
    if (bytes.length !== width * height) throw Error(`snow support mask size ${bytes.length} != ${width * height}`);
    if (this.removed) return;
    this.support = { width, height, bytes };
  }

  private uploadTextures(gl: WebGL2RenderingContext): void {
    // 在 render() 里上传：MapLibre 会在我们的 GL 调用后失效自己的状态缓存。
    const keys = [gl.UNPACK_FLIP_Y_WEBGL, gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.UNPACK_ALIGNMENT];
    const previous = keys.map((key) => gl.getParameter(key));
    try {
      gl.pixelStorei(keys[0], false);
      gl.pixelStorei(keys[1], false);
      gl.pixelStorei(keys[2], gl.NONE);
      this.sources.forEach((source, index) => {
        if (!source) return;
        const tex = gl.createTexture()!;
        this.textures[index] = tex;
        gl.activeTexture(gl.TEXTURE0 + index);
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
        // Atlas：经度方向重复、85° 行 clamp、三线性。
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.generateMipmap(gl.TEXTURE_2D);
      });
      if (this.support) {
        const { width, height, bytes } = this.support;
        const tex = gl.createTexture()!;
        this.textures[4] = tex;
        gl.activeTexture(gl.TEXTURE0 + 4);
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, width, height, 0, gl.RED, gl.UNSIGNED_BYTE, bytes);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.generateMipmap(gl.TEXTURE_2D);
      }
      this.uploaded = true;
      this.sources = [];
    } finally {
      keys.forEach((key, i) => gl.pixelStorei(key, previous[i]));
    }
  }

  setActive(active: boolean): void {
    this.state.active = active;
    this.map?.triggerRepaint();
  }

  setSun(sun: [number, number, number], timeDays: number): void {
    this.state.sun = sun;
    this.state.timeDays = timeDays;
    this.map?.triggerRepaint();
  }

  /** 昼夜光照开关（demo cycle 语义）：只改 uniform，不重建纹理/程序。 */
  setCycle(on: boolean): void {
    if (this.state.cycle === on) return;
    this.state.cycle = on;
    this.map?.triggerRepaint();
  }

  /** 近/中景夜路权重。Round 12 起 shader 用原作两条曲线，near/mid 不再驱动
   *  takeover uniform；两者仍被记录（诊断/兼容），签名保持不变。 */
  setHandovers(near: number, mid: number): void {
    this.state.roadHandoff = near;
    this.state.midHandoff = mid;
    this.map?.triggerRepaint();
  }

  /** 稀疏低模路网（arterial fallback）是否为当前可见路网 → u_road_fallback：
   *  为 true 时 shader 把 atlas 再乘 FALLBACK_ATLAS_GAIN（0.65），让稀疏线段可读；
   *  真实路网传 false，保持原作曲线。 */
  setRoadFallback(fallback: boolean): void {
    if (this.state.roadFallback === fallback) return;
    this.state.roadFallback = fallback;
    this.map?.triggerRepaint();
  }

  render(gl: WebGL2RenderingContext, args: any): void {
    if (!this.state.active || !this.ready || this.failed || !this.program || !this.lut) return;
    if (!this.uploaded) this.uploadTextures(gl);
    // Round 12 P2 follow-up：首帧之后启动高分灯图（与缩放、夜路数据无关），
    // 解码完成后尽快换进 texture unit 0。
    if (this.uploaded && !this.hiAtlasScheduled) this.scheduleHiAtlas();
    if (this.pendingAtlas) this.swapAtlas(gl);
    const projection = args?.defaultProjectionData;
    if (!projection?.mainMatrix) return;
    const define = String(args?.shaderData?.define ?? '');
    const globe = define.includes('GLOBE');
    if (globe && projection.projectionTransition < 0.999) return;
    if (!invertMat4(this.inverse, projection.mainMatrix as number[])) return;

    const s = this.state;
    const u = this.uniforms;
    const dn = dayNightUniforms(s.cycle);
    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);
    gl.disable(gl.DEPTH_TEST);
    gl.depthMask(false);
    gl.disable(gl.STENCIL_TEST);
    gl.disable(gl.CULL_FACE);
    gl.enable(gl.BLEND);
    gl.blendEquation(gl.FUNC_ADD);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

    const center = this.map.getCenter();
    const lat = center.lat * Math.PI / 180;
    const lon = center.lng * Math.PI / 180;
    const centerVec = [Math.sin(lon) * Math.cos(lat), Math.sin(lat), Math.cos(lon) * Math.cos(lat)];

    gl.uniformMatrix4fv(u.u_inverse, false, this.inverse);
    gl.uniform3fv(u.u_sun, s.sun);
    gl.uniform3fv(u.u_center, centerVec);
    gl.uniform1f(u.u_globe, globe ? 1 : 0);
    gl.uniform1f(u.u_zoom, this.map.getZoom());
    // Round 12 P7：detail zoom 不等于相机 zoom。flglobe::tiles::tile_zoom
    // （VA 0x180272120，round-12-deep-re 复原）对相机正下方的瓦片返回
    //     viewZoom + log2(1 / (3/sqrt(10))) = viewZoom + 0.076001546722525，
    // 与视口高度、pitch 无关（两者相消；见 DETAIL-ZOOM-REPORT.md §2.1/§5）。
    // 偏离中心的瓦片会从这个值往下掉，但 shader 只取一个标量，中心值即可。
    gl.uniform1f(u.u_detail, this.map.getZoom() + DETAIL_ZOOM_OFFSET);
    gl.uniform1f(u.u_cycle, dn.cycle);
    gl.uniform1f(u.u_lights, dn.lights);
    gl.uniform1f(u.u_material, 1);
    gl.uniform1f(u.u_atmosphere, 1);
    // 深浅主题与"原作地球配色"解耦：u_dark 恒为 1（已验收语义，候选 globeOriginal=true）。
    gl.uniform1f(u.u_dark, 1);
    gl.uniform1f(u.u_compare, 0);
    gl.uniform1f(u.u_snow, 1);
    gl.uniform1f(u.u_time_days, s.timeDays);
    gl.uniform1f(u.u_twinkle, 0);
    gl.uniform1f(u.u_debug, 0);
    gl.uniform1f(u.u_road_fallback, s.roadFallback ? 1 : 0);
    if (this.texelSizes[1]) gl.uniform2fv(u.u_elevation_texel, this.texelSizes[1]);
    if (this.texelSizes[0]) gl.uniform2fv(u.u_lights_texel, this.texelSizes[0]);

    this.textures[5] = this.lut;
    for (let i = 0; i < 6; i++) {
      gl.activeTexture(gl.TEXTURE0 + i);
      gl.bindTexture(gl.TEXTURE_2D, this.textures[i] ?? null);
    }
    for (const [i, name] of ['t_lights', 't_elevation', 't_material', 't_snow', 't_snow_support', 't_lut'].entries()) {
      gl.uniform1i(u[name], i);
    }
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
  }

  private disposeGL(gl: WebGL2RenderingContext): void {
    if (this.lut) { gl.deleteTexture(this.lut); this.lut = null; }
    for (const texture of this.textures) if (texture) gl.deleteTexture(texture);
    this.textures = [];
    this.sources = [];
    if (this.buffer) { gl.deleteBuffer(this.buffer); this.buffer = null; }
    if (this.vao) { gl.deleteVertexArray(this.vao); this.vao = null; }
    if (this.program) { gl.deleteProgram(this.program); this.program = null; }
    this.uniforms = {};
    this.uploaded = false;
    this.ready = false;
  }

  onRemove(_map: MLMap, gl: WebGL2RenderingContext): void {
    this.removed = true;
    this.cancelScheduledHiAtlas();
    this.disposeGL(gl);
  }
}
