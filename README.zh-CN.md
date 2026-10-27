# GCMap Modern

GCMap Modern 是一个浏览器端的大圆航线地图工具。输入机场代码即可建立一条或多条航线，
应用在 Apple Maps 风格的地图上绘制机场之间的大圆航线，并给出每一段的距离与初始航向，
总距离支持千米、英里、海里三种单位换算。

[English](README.md) | 简体中文

## GitHub Pages 地图部署

部署工作流以 `VITE_STATIC_MAP=1` 构建：浏览器通过 HTTP Range 读取公开的
Flightline world/buildings PMTiles，夜路几何由 Web Worker 计算。字体、行星纹理、
冰川支撑、海底与地形档案来自 `public/map-static/`，线上不需要 Node 地图后端或本地游戏安装。
固定近景快照失效时，回退正确坐标变换的官方 world z12/buildings z14 祖先瓦片，细节会降低。
本地 Google XYZ 影像、私有地址和接线代码不进入公开仓库。日常本地开发仍可使用 `/map-res/` 服务。

## 功能

- **双底图：** Apple 配色的矢量底图，全球地表覆盖影像垫底，带地形晕染与地表/土地利用
  色块；另有卫星影像模式（MapTiler 影像 + 陆地色彩管线 + 矢量水体铺色）。两种模式下地名标注均保持可读。
- **3D 地球：** 全球视野下地图渲染为星空中的 3D 地球，放大时平滑过渡回平面地图；
  「回正」入口随时恢复正北朝向与俯平视角。
- **3D 地形：** 开启后地形立体起伏（与山体晕染同源数据），山地地貌与航线立体呈现；
  球体与平面模式下均可用。
- **深色模式：** 面板与控件默认采用深色磨砂主题，地图选项菜单可随时切回浅色
  （`?theme=light` 直达浅色）。
- **多航线管理：** 航线以列表管理，每条可独立控制显隐、颜色与线宽，新建航线自动分配配色。
- **航线收藏与草稿：** 当前全部航线（含颜色、粗细、显隐与真实航路）自动保存为本机草稿，
  打开裸地址即恢复上次会话；也可命名保存为收藏，随时一键恢复（替换前可撤销）。
  收藏与草稿只存在本机浏览器，不进分享链接。
- **飞行足迹：** 在机场信息卡一键标记「去过」，摘要卡把航程记入足迹；
  累计里程与去过的机场数在左侧足迹卡统计，全部数据只存本机。
- **机场信息卡：** 点击地图上的机场 Pin 弹出信息卡：名称、IATA/ICAO、城市/国家、
  标高与坐标，并可直接标记「去过」。
- **删除撤销：** 删除航线后底部出现撤销入口（约 8 秒），一键按原位原样式恢复。
- **大圆几何：** 每段距离与初始航向、航线总距离、km/mi/nm 即时换算；跨日期变更线的航线
  连续绘制。
- **飞行时间与巡航速度：** 摘要卡按"单段距离分档的巡航假设"估算飞行时间——<4,000 km 用窄体
  M0.78（830 km/h）、≥4,000 km 用宽体 M0.85（903 km/h），另加每段起降开销；导入 SimBrief
  计划后改用计划本身的空中时间与巡航速度。巡航速度恒定同时显示三个单位（马赫 · km/h · kt）；
  跳转 SimBrief 的默认机型也按同一 4,000 km 分档（A21N / A359）。
- **SimBrief 真实航路：** 可把航线替换为真实飞行计划航路——应用带起降与机型（按航程分档：
  <4,000 km 默认 A321neo，≥4,000 km 默认 A350-900）参数打开 SimBrief 生成页，计划生成后自动
  导回，按实际航点绘制。需免费注册 SimBrief，无需 API key。
- **双语地名：** 地图标注在中文与英文之间实时切换，也可整体隐藏。
- **机场检索：** 内置 OurAirports 数据库共 8,799 个机场，支持 IATA/ICAO 代码或名称搜索。
- **两种输入模式：** 标签流输入便于交互式编排；raw 文本模式可一次粘贴多条航线。
- **右上角选项菜单：** 底图、3D 地球、3D 地形、回正、地名开关与语言收拢在右上角单按钮的
  菜单里；航线收藏在它左侧的书签按钮里。
- **URL 直达：** 航线、语言、底图、投影、单位、地名开关、主题等全部状态编码在 URL 中，
  打开即复原。

## 快速开始

环境要求：Node.js 20.19+ 或 22.12+（Vite 8 要求），npm。

```bash
npm install
npm run dev
```

开发服务器运行于 http://127.0.0.1:5173。

### 可选：MapTiler 卫星影像

卫星底图使用 MapTiler 影像，海面以矢量水体多边形铺色（无误判）、陆地在浏览器内做
色彩分级。两种激活方式：

- **在线使用（无需构建）：** 打开右上角「地图选项」菜单，在「卫星 Key」一栏粘贴自己的
  API key 并回车即可，key 只保存在本机浏览器中，可随时点「换 Key」更换；
- **自部署：** 在 [MapTiler Cloud](https://cloud.maptiler.com) 注册领取免费 API key，
  在项目根目录创建 `.env.local` 文件并写入

```
VITE_MAPTILER_KEY=你的key
```

然后重启开发服务器（或重新构建）。没有 key 时自动回退到免 key 的 Esri World Imagery，
新检出开箱即用。key 仅存本地（`.env*` 已被 gitignore、菜单填入的 key 只进浏览器
localStorage），绝不提交。

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
| `sbr` | polyline 编码的航点序列 | 真实航路快照，每条一个；由应用自动写入，打开即恢复 |
| `sbt` | `分钟-TAS-马赫` | 与 `sbr` 配对存储的计划元数据（空中时间与巡航速度）；无则不写 |
| `sbf` | SimBrief 用户名 | 打开时拉取该用户最新飞行计划，画成真实航路 |
| `lang` | `zh`、`en` | 地名语言 |
| `base` | `vector`、`satellite` | 底图模式 |
| `globe` | `1` | `1` 低缩放渲染为 3D 地球；缺省为平面地图 |
| `terrain` | `1` | `1` 开启 3D 地形起伏；缺省为平面 |
| `u` | `km`、`mi`、`nm` | 距离单位 |
| `labels` | `0` | `0` 隐藏地名；缺省显示 |
| `theme` | `light` | `light` 使用浅色界面主题；缺省为深色模式 |

示例：`/?route=LHR-SIN-SYD;PEK-JFK&base=satellite&u=nm`

## 机场数据

`src/data/airports.json` 由 [OurAirports](https://ourairports.com/data/) 数据库生成
（保留含 IATA 代码的 large/medium/small 机场，以及仅有 ICAO 代码的大型机场，含标高字段，
供机场信息卡展示），已随仓库提交，新检出无需重新生成。

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
│   ├── components/             # 搜索面板、航线列表、航线明细、足迹卡、收藏菜单、机场信息卡、右上选项菜单
│   ├── state/saved.ts          # 本地持久化：草稿 / 航线收藏 / 飞行足迹（localStorage）
│   ├── data/                   # airports.json（生成产物）与检索逻辑
│   ├── geo/greatCircle.ts      # Haversine 距离、初始方位角、slerp 采样、单位换算
│   ├── i18n/strings.ts         # 中/英文案
│   ├── simbrief/simbrief.ts    # SimBrief 接入：生成页跳转、OFP 拉取解析、航路快照
│   └── map/
│       ├── styleFactory.ts     # 成品样式适配：图层分组、卫星层、地名标注
│       ├── oceanTint.ts        # 卫星瓦片逐像素处理（海洋调色，自定义协议）
│       └── MapController.ts    # MapLibre 封装：图层、标记、底图切换
├── design-assets/              # 构建所需的成品样式与地表覆盖资产
└── scripts/build-airports.mjs  # OurAirports CSV -> src/data/airports.json
```

## 数据来源与署名

应用渲染第三方地图数据。地图右下角的署名控件承载以下信息，依相应许可要求不得移除。

- **矢量瓦片与地名** — OpenFreeMap 服务；底层数据 © OpenStreetMap contributors（ODbL）。
- **矢量底图样式** — 本项目生成；地表覆盖与土地利用配色源自 OSM Carto（CC0）。
- **地表覆盖影像** — NASA EOSDIS GIBS，本项目重新配色。
- **地形晕染与 3D 地形** — AWS Open Data Terrain Tiles（Mapzen）。
- **卫星影像** — MapTiler（© MapTiler © OpenStreetMap contributors），海面以 OpenFreeMap
  矢量水体多边形铺色；未配置 key 时回退 Esri World Imagery（Esri、Maxar、Earthstar Geographics）。
- **机场数据库** — OurAirports.com（公有领域）。
- **飞行计划数据** — [SimBrief](https://www.simbrief.com)（需免费注册）；真实航路来自用户
  自己账号生成的飞行计划。
- **字体** — Inter（SIL Open Font License）。

## 许可证

源代码以 [MIT License](LICENSE) 发布。上列地图数据、影像与机场数据库仍适用其各自的
许可证与署名要求。
