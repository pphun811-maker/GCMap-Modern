# GCMap Modern

GCMap Modern 是一个浏览器端的大圆航线地图工具。输入机场代码即可建立一条或多条航线，
应用在 Apple Maps 风格的地图上绘制机场之间的大圆航线，并给出每一段的距离与初始航向，
总距离支持千米、英里、海里三种单位换算。

[English](README.md) | 简体中文

## 功能

- **双底图。** Apple 配色的矢量底图，全球地表覆盖影像垫底，带地形晕染与地表/土地利用
  色块；另有 Esri World Imagery 卫星影像模式。两种模式下地名标注均保持可读。
- **多航线管理。** 航线以列表管理，每条可独立控制显隐、颜色与线宽，新建航线自动分配配色。
- **大圆几何。** 每段距离与初始航向、航线总距离、km/mi/nm 即时换算；跨日期变更线的航线
  连续绘制。
- **双语地名。** 地图标注在中文与英文之间实时切换，也可整体隐藏。
- **机场检索。** 内置 OurAirports 数据库共 8,799 个机场，支持 IATA/ICAO 代码或名称搜索。
- **两种输入模式。** 标签流输入便于交互式编排；raw 文本模式可一次粘贴多条航线。
- **URL 直达。** 航线、语言、底图、单位、地名开关等全部状态编码在 URL 中，打开即复原。

## 快速开始

环境要求：Node.js 20.19+ 或 22.12+（Vite 8 要求），npm。

```bash
npm install
npm run dev
```

开发服务器运行于 http://127.0.0.1:5173。

生产构建：

```bash
npm run build    # 类型检查并打包到 dist/
npm run preview  # 本地预览生产构建
```

## URL 参数

应用状态可通过查询参数预设，URL 与界面保持同步。

| 参数 | 取值 | 说明 |
| ---- | ---- | ---- |
| `route` | `LHR-SIN-SYD;PEK-JFK` | 机场代码用 `-` 连接（直飞或含经停），多条航线用 `;` 分隔 |
| `lang` | `zh`、`en` | 地名语言 |
| `base` | `vector`、`satellite` | 底图模式 |
| `u` | `km`、`mi`、`nm` | 距离单位 |
| `labels` | `0` | `0` 隐藏地名；缺省显示 |

示例：`/?route=LHR-SIN-SYD;PEK-JFK&base=satellite&u=nm`

## 机场数据

`src/data/airports.json` 由 [OurAirports](https://ourairports.com/data/) 数据库生成
（保留含 IATA 代码的 large/medium/small 机场，以及仅有 ICAO 代码的大型机场），已随仓库
提交，新检出无需重新生成。

如需用更新的 OurAirports 快照重建：下载 `airports.csv` 放到 `scripts/airports.csv`，
执行：

```bash
npm run build:airports
```

## 项目结构

```
├── index.html
├── src/
│   ├── App.tsx                 # 应用状态与 URL 同步
│   ├── app.css                 # UI 样式
│   ├── components/             # 搜索面板、航线列表、航线明细、右上控制组
│   ├── data/                   # airports.json（生成产物）与检索逻辑
│   ├── geo/greatCircle.ts      # Haversine 距离、初始方位角、slerp 采样、单位换算
│   ├── i18n/strings.ts         # 中/英文案
│   └── map/
│       ├── styleFactory.ts     # 成品样式适配：图层分组、卫星层、地名标注
│       └── MapController.ts    # MapLibre 封装：图层、标记、底图切换
├── design-assets/              # 构建所需的成品样式与地表覆盖资产
└── scripts/build-airports.mjs  # OurAirports CSV -> src/data/airports.json
```

## 数据来源与署名

应用渲染第三方地图数据。地图右下角的署名控件承载以下信息，依相应许可要求不得移除。

- **矢量瓦片与地名** — OpenFreeMap 服务；底层数据 © OpenStreetMap contributors（ODbL）。
- **矢量底图样式** — 本项目生成；地表覆盖与土地利用配色源自 OSM Carto（CC0）。
- **地表覆盖影像** — NASA EOSDIS GIBS，本项目重新配色。
- **地形晕染** — AWS Open Data Terrain Tiles（Mapzen）。
- **卫星影像** — Esri World Imagery（Esri、Maxar、Earthstar Geographics）。
- **机场数据库** — OurAirports.com（公有领域）。
- **字体** — Inter（SIL Open Font License）。

## 许可证

源代码以 [MIT License](LICENSE) 发布。上列地图数据、影像与机场数据库仍适用其各自的
许可证与署名要求。
