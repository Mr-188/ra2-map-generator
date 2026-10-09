# RA2 / YR 随机地图生成器

在浏览器里生成**并渲染**《红色警戒 2 / 尤里的复仇》随机地图。

**纯静态前端**：没有后端，不打包任何游戏素材，一切从玩家自己的游戏目录读。
游戏文件不离开玩家的机器。

---

## 它做什么

```
用户打开网页
  │  选自己的游戏目录（ra2.mix / ra2md.mix / expandmd01.mix）
  ├─ 点「生成地图」
  │    Worker 里：C++ 引擎从归档提取素材 → 生成 .map
  └─ 点「渲染预览」
       主线程：CNCMaps 用刚提取的素材渲染成 PNG
```

预览图**与 CNCMaps 本机渲染逐像素一致**——不是"看起来像"，是同一份渲染器代码
编译到 WebAssembly。

## 怎么用

1. 打开页面（见 [docs/DEPLOY.md](docs/DEPLOY.md) 自行部署）
2. 选你的 RA2/YR 安装目录
3. 调参数，点生成
4. 点渲染预览（**首次约 15–30 秒**，之后约 2 秒）

下载得到 `.yrm`（多人）或 `.map`（单人），放进游戏目录即可玩。

**地图大小**有两种模式：

- **正方形**（默认）：一个滑杆，小数可调。引擎按 `W = Wmin*(1-f) + Wmax*f`、`f = 滑杆/3`
  插值尺寸表，三种"岛屿"地形把 `f` 钳在 1.2（滑杆上限 3.6），内陆与山地不钳制。
  滑杆的上下限、步长全部由引擎给出（`SizeSliderRange` / `kSizeSliderStep`），
  页面不自己抄一份。
- **长 × 宽**：直接指定两个边。尺寸表让 W 和 H 取同一个值，所以**滑杆只能做出正方形**；
  指定长宽是唯一能得到非方图的途径。上限是**两边之和** 495，因为 overlay 网格按
  `mapWidth + mapHeight` 寻址——所以 380×100 这类长条图能做到方图做不到的尺寸
  （方图边长上限约 247）。

> 非方图在引擎侧完整跑通（生成、写出、解码、验收都覆盖），但**随机地图生成器此前
> 从未产出过矩形图**，游戏客户端能否正常加载需要实机确认。

---

## 架构

产物由**两个互不相干的 WebAssembly 运行时**组成，这个划分是被逼出来的：

| | 跑在哪 | 为什么 |
|---|---|---|
| **生成引擎**<br>C++ → Emscripten，720 KB | **Worker** | `ByteSource::read` 是同步的，而唯一能同步读用户 `File` 的 API 是 `FileReaderSync`，它只在 Worker 里存在。把 269 MB 的 `ra2.mix` 整个拷进内存是行不通的 |
| **渲染器**<br>C# → .NET browser-wasm，14 MB | **主线程** | .NET 运行时靠 `typeof importScripts` / `typeof window` 判断宿主环境。在 Worker 里它判定自己是"未知 shell 环境"，然后在 `dotnet.create()` 里**静默卡死**。主线程有 `window`，判定没有歧义 |

**核心设计**：两个参考实现都只读散文件。所以做法是**把归档解码一次**成它们期望的
散文件布局，两边共用——MIX 解析只写一遍，而且有验收保证它和 Python 参考实现逐字节一致。

渲染器**懒加载**：打开页面只要 726 KB，14 MB 的渲染器在第一次点渲染时才下载。

---

## 目录

| 路径 | 作用 |
|---|---|
| `engine/` | C++ 引擎（原生 + Emscripten 双目标） |
| `webapp/` | 前端页面 |
| `tools/` | 构建工具链与验收套件 |
| `maptools/` | Python 格式层，**仅作验收 oracle** |
| `docs/` | [部署指南](docs/DEPLOY.md)、[同类项目评估](docs/external_mapgenerator_yaoyaojiang.md) |

`engine/src/` 逐层：

```
crc32.h         文件名 → 32 位 CRC（MIX 索引里没有文件名）
blowfish.*      头解密（Westwood 公钥派生密钥）
mix.*           嵌套 MIX 解析、按哈希查名、覆盖顺序（md 版胜出）
byte_source.*   ByteSource：文件 / 内存 / 浏览器 File 的切片
ini.*           Windows GetPrivateProfile* 语义
extract.*       把归档物化成生成器与渲染器都要的散文件树
win32/          Win32 垫片：让参考实现以散文件方式跑，永不接触 MIX
```

---

## 构建

需要一次性的环境准备（Emscripten、.NET 10 SDK、参考实现），全部**不需要 root**，
详见 [docs/DEPLOY.md](docs/DEPLOY.md) 第二节。

```sh
sh engine/build_oracle.sh                              # 原生对照
sh -c '. tools/emenv.sh && sh engine/build_web.sh'     # 浏览器引擎
sh engine/build_render_web.sh                          # 浏览器渲染器
```

## 验收

```sh
sh tools/verify_all.sh
```

| 套件 | 证明什么 |
|---|---|
| `verify_mix` | C++ MIX 层与 Python oracle 逐字节一致 |
| `verify_extract` | 提取覆盖归档里所有被请求的 tile |
| `verify_oracle` | 参考管线出图，同种子逐字节可复现，且结构不退化 |
| `verify_wasm` | WASM 与原生**逐字节相同** |
| `verify_render` | 散文件树渲染结果与用游戏 MIX 渲染**逐像素相同** |
| `verify_webapi` | 浏览器入口契约，含 worker 的摊平 + 渲染流程 |
| `verify_uicontract` | 页面与 worker 的消息词表一致 |
| `verify_browser` | **真实浏览器**里页面能生成 + 渲染 |

**任何一条红了都不要往下走。**

---

## 已知的平台陷阱

跨平台改动**必须两边对拍**。项目里踩过的三个，都不会报错，只会让结果不一样：

- **MSVC 的 `%s` 是宽串，glibc 是多字节**——要用 `%ls`
- **路径大小写敏感 + 反斜杠 vs 正斜杠**
- **musl 的 `vswprintf` 在 `"C"` locale 下遇到非 ASCII 就截断**——曾让 WASM 版每一条
  剧场 tile 路径都落空，地图小 25%，**零报错**。所以 `swprintf_s` 是自己实现的，
  不依赖任一 C 库的 locale 行为

还有一条：**`DWORD` 之类的类型是定宽的**。`unsigned long` 在 Windows 和 wasm32 上是
32 位、在 Linux 上是 64 位，按自然写法写会让原生和 wasm 静默分歧。

---

## 许可证与红线

1. **参考实现的代码、二进制、原版游戏素材不提交进仓库或产品。**
   构建时从各自来源取，产物只有那 67 个静态文件。
2. **产品是纯静态前端**：没有后端，不接收上传，用户素材不离开本机。
3. 生成必须确定：相同参数 + 相同种子 → **逐字节相同**。
4. **每一行都要能指出出处**；指不出出处的代码不许留在产品里。
5. **CNCMaps 是 GPL v3**（详见 `reference_impl/ccmaps-net/COPYING`）。
   分发编译产物就必须向用户提供对应源码——本仓库公开，即满足该义务。
   参考 RMG 实现为闭源，仅在本机构建时使用，**不随产品分发**。
