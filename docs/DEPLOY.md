# 完整流程：从零到上线

这份文档是端到端的操作手册。每一步都标了**我是否实际验证过**——没有验证过的我会写清楚。

产品形态：**纯静态前端**。没有后端，不打包任何游戏素材，玩家用自己的游戏目录。

---

## 目录

- [一、这是什么](#一这是什么)
- [二、一次性准备构建环境](#二一次性准备构建环境)
- [三、构建](#三构建)
- [四、验收](#四验收)
- [五、打包](#五打包)
- [六、部署到 EdgeOne Makers（免费）](#六部署到-edgeone-makers免费)
- [七、验证线上](#七验证线上)
- [八、以后怎么更新（一条命令）](#八以后怎么更新一条命令)
- [八点五、为什么不能"推 GitHub 就自动构建"](#八点五为什么不能推-github-就自动构建)
- [九、日常开发](#九日常开发)
- [十、出问题怎么查](#十出问题怎么查)

---

## 一、这是什么

浏览器里生成并渲染 RA2/YR 随机地图。

```
用户打开网页
  ↓ 选自己的游戏目录（ra2.mix / ra2md.mix / expandmd01.mix）
  ↓ 点生成
     worker 里：C++ 引擎（Emscripten）从归档提取素材 → 生成 .map
  ↓ 点渲染预览
     主线程：CNCMaps（.NET 编译成 browser-wasm）用提取的素材渲染成 PNG
  ↓ 下载 .map / 下载预览图
```

**关键设计**：

| 决定 | 原因 |
|---|---|
| 生成引擎在 **Worker** 里 | `FileReaderSync` 只在 Worker 里有，这是"按需读 269 MB 的 ra2.mix"的唯一办法 |
| 渲染器在**主线程** | .NET 运行时靠 `typeof importScripts`/`typeof window` 判断宿主，在 Worker 里会误判成未知环境并**静默卡死** |
| 提取成**散文件树** | 参考实现和 CNCMaps 都只读散文件；两者都不碰 MIX |
| 渲染器**懒加载** | 打开页面只要 726 KB；14 MB 的渲染器在第一次点渲染时才下载 |

体积：页面 726 KB；渲染器 14.2 MB。合计 67 个文件 / 16 MB。

---

## 二、一次性准备构建环境

**这一节只在一台新机器上做一次。** 所有工具都装在用户目录下，**不需要 root**。
✅ 全部在本机实测通过。

```sh
cd <项目目录>

# 1. Emscripten（解到 ~/opt/emscripten）
#    默认从 questing 取 3.1.69，而不是本机发行版的版本——见下方说明。
sh tools/fetch_emscripten.sh

# 2. .NET 10 SDK + 一个缺失的系统库（同样走 apt，不用 root）
sh tools/fetch_apt.sh ~/opt/dotnet-apt ~/opt/dotnet-dl dotnet-sdk-10.0
sh tools/fetch_apt.sh ~/opt/dotnet-apt ~/opt/dotnet-dl libunwind8

# 3. .NET 的 wasm 工具链
export DOTNET_ROOT=~/opt/dotnet-apt/usr/lib/dotnet
export PATH=~/opt/dotnet-apt/usr/bin:$PATH
export LD_LIBRARY_PATH=~/opt/dotnet-apt/usr/lib/x86_64-linux-gnu
dotnet workload install wasm-tools

# 4. 参考实现（构建时需要，永不提交）
git clone https://github.com/zzattack/ccmaps-net reference_impl/ccmaps-net
#   参考 RMG 实现放 reference_impl/src/（本项目来源，非公开）

# 4b. 把本仓库对参考实现的补丁打上去（**必须**，否则编译不过：
#     我们的驱动调用 RandomMapGenerator::SizeSliderRange，干净版没有）
sh tools/apply_reference_patches.sh

# 5. 【可选】Chromium + puppeteer，用于真实浏览器自测
sh tools/fetch_chromium.sh
npm install puppeteer-core
```

> **为什么用 apt 包而不是官网下载**：微软 CDN 从国内几乎拉不动（实测 70 秒只有 4 KB）。
> 所有下载脚本都用**并行分块**，因为单条长连接会被限速到几百 KB/s。

> **为什么 Emscripten 不取本机发行版的版本**：Ubuntu 24.04 带的是 3.1.6，它**
> 不支持 `-sSTACK_SIZE`**，而且早于 clang 把 `main()` 改名为 `__main_argc_argv` 的
> 版本——于是链接时找不到入口根，**把整个程序当死代码剥光**，产出一个 11 KB、
> exit 0、什么都不做的 wasm，且全程无报错。所以 `fetch_emscripten.sh` 默认从
> `questing`（3.1.69）取，并在解包后**剔掉该 suite 自带的 libc / ld-linux**：它们会被
> `emenv.sh` 放进 `LD_LIBRARY_PATH`，让环境里每个进程（含 python3）去加载比本机
> 更新的 glibc，直接 `stack smashing detected`。工具链自身的库是兼容的（实测最高
> 需要 GLIBC_2.38 / GLIBCXX_3.4.30，本机 2.39 / 3.4.33）。用 `SUITE=` 可换，
> `SUITE=native` 用本机 apt 列表。

---

## 三、构建

✅ 全部实测通过。

```sh
# 1. 原生 oracle（对照真值，需要 reference_impl/src/）
sh engine/build_oracle.sh

# 2. Node 版 wasm（用于和原生对拍）
sh -c '. tools/emenv.sh && sh engine/build_wasm.sh'

# 3. 浏览器版引擎（会暂存进 webapp/）
sh -c '. tools/emenv.sh && sh engine/build_web.sh'

# 4. 浏览器版渲染器（会把 CNCMaps 编成 wasm 并暂存进 webapp/render/）
sh engine/build_render_web.sh
```

产物：

| 文件 | 大小 | 作用 |
|---|---|---|
| `webapp/mg_engine.js` + `.wasm` | 720 KB | 生成引擎 |
| `webapp/render/_framework/` | 14.2 MB | 渲染器（59 个文件） |

⚠️ **浏览器产物不能带 `node` 环境**：`-sENVIRONMENT=worker,node` 会让 Emscripten 生成一句
`import { createRequire } from 'module'`，浏览器解析不了，worker 直接死掉。
`build_web.sh` 暂存时会检查这一点，出现了就让构建失败。

---

## 四、验收

✅ 十一套全绿，含**真实浏览器端到端**。

```sh
sh tools/verify_all.sh
```

| 套件 | 证明什么 |
|---|---|
| `verify_mix` | C++ MIX 层与 Python oracle 逐字节一致（35 项） |
| `verify_extract` | 提取覆盖归档里所有被请求的 tile（954 个） |
| `verify_oracle` | 参考管线出图，同种子逐字节可复现 |
| `verify_wasm` | WASM 与原生**逐字节相同** |
| `verify_size` | 尺寸上限由引擎单点决定，且它自己拒绝越界参数 |
| `verify_symmetry` | 对称映射是双射、各族朝向闭合、生成出的图自身对称 |
| `verify_render` | 散文件树渲染结果与用游戏 MIX 渲染**逐像素相同** |
| `verify_webapi` | 浏览器入口契约成立，含 worker 的摊平+渲染流程 |
| `verify_uicontract` | 页面和 worker 的消息词表一致 |
| `verify_deploy` | 部署路径拒绝发布未构建/过期/空的字节，且 token 不进命令行（离线，用桩 CLI） |
| `verify_browser` | **真实浏览器**里页面能生成 + 渲染 |

**任何一条红了都不要往下走。**

---

## 五、打包

✅ 实测通过。

```sh
sh tools/package_webapp.sh
```

产出：

```
build/webapp/        69 个文件 / 16 MB   ← 可直接部署
build/webapp.zip     5.7 MB             ← 拖拽上传用（内容在根层）
```

脚本会：

- 只拷该发布的文件（排除测试用的 `game` 符号链接和探针页面）
- 带上 `edgeone.json`（给托管商看的规则：`.wasm` 的 Content-Type + 缓存策略）
- 抹掉产物里烤进的**构建机路径**（Emscripten 的注释里带着 `/home/xxx/...`）
- 检查有没有残留的绝对路径或本机 URL，**有就让构建失败**

---

## 六、部署到 EdgeOne Makers（免费）

> **证据状态**：界面步骤来自腾讯官方文档，**没有账号，未实测**。
> CLI 侧实测过的只有：`edgeone@1.6.41` 的参数表（`makers deploy`，`pages` 已弃用）、
> 静态目录的本地构建阶段（只拷贝文件，不跑 npm）、`edgeone validate` 接受了
> `webapp/edgeone.json` 的规则、以及无 token 时在上传前就失败（exit 1）。
> **真正的上传没有跑过**——那需要一个属于你的 API Token（或 `edgeone login`）。
> 所以每次部署都会自动调 `tools/verify_deployed.sh` 核对线上：13 个关键文件的
> HTTP 状态和 Content-Type 对不上（尤其 `.wasm` 不是 `application/wasm`）就当场报错，
> 而不是等你在浏览器里发现按钮是灰的。

**为什么选它**：官网写明免费版"permanently available"，包含**自定义域名**和**免费 SSL 证书**；
单文件上限 25 MB（我们最大 1.3 MB）；不用 Git，可以直接传文件夹。

### 6.1 注册并创建项目

1. 打开 <https://edgeone.ai/register>，**注册并登录**
   （官方说明：*users in China need to register and log in*，否则链接只保留 1 小时）
2. 进入 Makers 控制台 → 新建项目
3. 部署方式选 **直接上传**（Direct Upload / Drop）

### 6.2 上传

> 这一步只做**一次**（创建项目）。之后的每次更新走第八节的一条命令，
> 不用再拖文件；`tools/deploy_edgeone.sh` 部署到同名项目就是原地更新。

解压 `build/webapp.zip`，把**里面的内容**（不是外层目录）拖进去。
或者直接把 `build/webapp/` 目录整体拖上去。

⚠️ **必须保留目录结构**——`render/_framework/` 里有 59 个文件，拍平了就跑不起来。
上传完在控制台里看一眼，`render/_framework/dotnet.js` 这个路径要存在。

⚠️ 项目要是**直接上传**类型：命令行部署只能更新这种类型的项目（`edgeone makers deploy` 的帮助里明说了）。

### 6.3 绑定你的域名

1. 项目 → **域名管理** → 添加自定义域名，填 `map.你的域名`
2. 控制台会给你一个 **CNAME 目标地址**
3. 去 **DNSPod**（腾讯云 DNS 解析）加记录：

   ```
   主机记录    记录类型    记录值
   map         CNAME      <控制台给的目标地址>
   ```

   ⚠️ 用**子域名**（`map.`）。根域名在 DNS 规范上不能用 CNAME。

4. 回到控制台 → **HTTPS 配置** → **申请免费证书** → 绑定

### 6.4 缓存配置（建议）

`webapp/edgeone.json` 已经把这些规则写进仓库，部署时会一起上传，所以**控制台里不用手配**：
`render/_framework/*` 缓存 7 天，`index.html` / `app.js` / `worker.js` 不缓存。
想核对每个文件该用什么 `Cache-Control`，`tools/deploy_cos.sh` 里那份表是同样的口径。

---

## 七、验证线上

✅ 工具实测通过。

```sh
sh tools/verify_deployed.sh https://map.你的域名/
```

查 13 个关键文件的 HTTP 状态和 **Content-Type**：

```
ok    index.html                             4795 B  text/html
ok    mg_engine.wasm                       646318 B  application/wasm
ok    render/_framework/dotnet.native.wasm 2943994 B  application/wasm
ok    missing file returns 404
OK -- the deployed copy serves every asset with usable metadata
```

**重点是 `.wasm` 必须是 `application/wasm`。** 这是静态托管最常见的坑：
托管商不认识 `.wasm`，默认发成 `application/octet-stream`，浏览器就**拒绝流式实例化
WebAssembly**，页面会永远卡在"引擎加载中"。

然后**在浏览器里真跑一次**：选游戏目录 → 生成 → 渲染预览。
这是唯一无法自动化的部分（浏览器测试需要同源喂游戏文件）。

---

## 八、以后怎么更新（一条命令）

✅ 脚本实测通过（离线部分 32 项断言；上传本身需要你的账号，见下）。

改完代码之后：

```sh
sh tools/deploy_edgeone.sh
```

它按顺序做这几件事：

1. **检查暂存产物是不是当前的** —— `webapp/mg_engine.wasm`、`webapp/render/` 比 `engine/src`、`engine/render` 旧就**拒绝发布**（提示该重跑哪个构建命令），而不是把旧字节传上去。
2. **打包**（`tools/package_webapp.sh`）
3. **体检**：引擎 wasm 小于 300 KB 就拒绝（那是 Emscripten 用错工具链时产出的 11 KB 空程序）；渲染器 `render/_framework` 少于 50 个文件或小于 10 MB 就拒绝；测试用的 `game` 软链在包里就拒绝。
4. **上传**：`edgeone makers deploy`（`edgeone pages` 已弃用），只走环境变量传 token。
5. **验证线上**：调 `tools/verify_deployed.sh`，逐个文件查 HTTP 状态和 **Content-Type**。

### 8.1 一次性配置

在项目根目录建 `.env`（**已在 `.gitignore`，别提交**），之后 `sh tools/deploy_edgeone.sh` 就是全部：

```sh
# .env
EDGEONE_PROJECT=<控制台里那个项目名>
EDGEONE_URL=https://你的域名/
EDGEONE_API_TOKEN=<API Token>
```

- **项目名**：EdgeOne 控制台里那个项目的名字。用同一个名字部署就是**原地更新**，自定义域名和 HTTPS 证书都不用再配一遍。（命令行更新要求项目是**直接上传**类型——你当初就是拖拽上传的，符合。）
  ⚠️ 名字写错**不会报错**：CLI 会直接新建一个项目，你的真实站点还在跑旧构建。脚本会拿日志里的
  `Creating new project with name` 当场提醒你，别把那条警告当成成功。
- **API Token**：控制台里创建，有效期可选 1 天～1 年（**建议设过期时间**）：
  - **国内站**：<https://console.cloud.tencent.com/edgeone/pages?tab=api> → **API Token** 标签页 → **创建 API Token** → 填描述、选过期时间 → 提交。官方文档：<https://cloud.tencent.com/document/product/1552/127422>
  - **国际站**：<https://console.tencentcloud.com/edgeone/pages>（`API Token` 标签页）→ 同样步骤。官方文档：<https://pages.edgeone.ai/zh/document/api-token>
  - **不需要设置区域**：CLI 会拿这个 token 依次试 `pages-api.cloud.tencent.com`（国内站）和 `pages-api.edgeone.ai`（国际站），谁认就用谁。`-a` 是**新建项目**时才用到的属性（`Area`），更新已有项目用不上。
  - `.env` 里写 `EDGEONE_API_TOKEN` 或 CLI 自己的名字 `EDGEONE_PAGES_API_TOKEN` 都可以。
- **不想用 token** 也行：在本机跑一次 `npx edgeone@1.6.41 login`（国内站加 `--site china`，会开浏览器），登录态存在 `~/.edgeone`，脚本不带 token 也能部署。

### 8.2 常用变体

```sh
sh tools/deploy_edgeone.sh --verify        # 先跑 tools/verify_all.sh，红了就不发布
sh tools/deploy_edgeone.sh -e preview      # 先发到 preview 环境，拿预览 URL 试
sh tools/deploy_edgeone.sh --dry-run       # 打包 + 体检 + 打印将要执行的命令，不上传
sh tools/deploy_edgeone.sh --force         # 明知产物比源码旧也要发（慎用）
```

`--verify` 会重建引擎；想省时间就 `MG_SKIP_BUILD=1 sh tools/verify_all.sh` 复用已有构建。

### 8.3 关于缓存

`webapp/edgeone.json` 已经写好了规则：`*.wasm` 一律 `Content-Type: application/wasm`，
`index.html` / `app.js` / `worker.js` / `mg_engine.js` 不缓存，14 MB 的渲染器缓存 7 天。
如果浏览器里看着还是旧的（改完 `worker.js` 之后尤其容易），**Ctrl+Shift+R 硬刷新一次**。

---

## 八点五、为什么不能"推 GitHub 就自动构建"

EdgeOne Pages 支持导入 Git 仓库、push 自动构建，但**这个项目用不了**，原因是硬的：

1. 引擎是 C++ 编译出来的 wasm。构建要 **Emscripten 3.1.69**（本机发行版的版本会静默产出空程序）。
2. 引擎的生成逻辑来自**参考 RMG 实现**，它**不在仓库里**（无许可证，红线 1），云端 checkout 拿不到。
3. 渲染器是 CNCMaps 编成的 wasm，源码同样只在构建机上；而且它是 **GPL v3**，产物是构建输出、不入库。

也就是说：**云端无论如何都造不出 `mg_engine.wasm` 和 `render/`**。能让云端部署的唯一办法，是先把这两个产物送到云端能读到的地方——而它们正是不能提交进仓库的东西。

三条路，按推荐顺序：

| 方案 | 怎么跑 | 代价 |
|---|---|---|
| **A. 本机一条命令**（推荐，已实现） | `sh tools/deploy_edgeone.sh` | 无。红线全部保持；只是"更新"这一步在本机跑 |
| **B. GitHub Actions 部署** | 本机打包成 Release 资产 → Actions 在 tag/release 时下载并 `edgeone makers deploy` | 编译产物（含 GPL 的渲染器）要挂到**公开仓库的 Release** 上；碰红线 1 的边界，得你拍板。好处是 token 只存在 GitHub Secrets |
| **C. 自托管 runner** | 在你这台机器上跑 GitHub Actions runner，push 后在本机构建并部署 | 真·push 即部署，但公开仓库 + 自托管 runner 意味着别人提 PR 就能在你机器上执行代码，风险明显更大 |

**B 和 C 我都没有替你选**：它们各自要动红线或暴露本机，得你明确同意再动。A 已经能覆盖日常更新，且和现在这套验收完全一致。

---

## 九、日常开发

```sh
# 本机起服务（页面 + 游戏目录同源，浏览器测试要用）
ln -sfn /path/to/RA2MD webapp/game
python3 -m http.server 8017 --directory webapp --bind 127.0.0.1
# 打开 http://127.0.0.1:8017/

# 真实浏览器端到端测试
node tools/verify_browser.mjs --game /path/to/RA2MD \
     --gameurl http://127.0.0.1:8017/game/ --shot /tmp/page.png
```

`webapp/game` 只是测试用的符号链接，**不要提交**（已在 `.gitignore`）。

---

## 十、出问题怎么查

**页面一片安静、按钮点不动** → 页面日志框（底部）有 worker 的全部输出和 .NET 运行时的诊断。
还不行就 F12 开 Console。

**症状 → 原因对照表**（都是实际踩过的）：

| 症状 | 原因 |
|---|---|
| 按钮一直灰的，日志只有两行 | worker 里某个函数没定义（`fail`/`mark`/`boot` 缺一个就整条链断掉） |
| 引擎在 20 秒内没有就绪 | `mg_engine.js`/`.wasm` 没提供，或 404 |
| 卡在 `starting the runtime` | .NET 运行时在 Worker 里误判宿主环境（必须放主线程） |
| 卡在 `引擎加载中` 且 `.wasm` 是 200 | `.wasm` 的 Content-Type 不是 `application/wasm` |
| 渲染出来了但页面没反应 | worker 发的消息类型页面没接（`verify_uicontract` 能提前抓到） |
| 地图比预期小 25% | 剧场 tile 路径里的非 ASCII 被截断（musl 的 `vswprintf` 在 C locale 下的行为） |
| 部署脚本说 REFUSING，提到某个 `engine/src/...` | 产物比源码旧，先按提示重跑构建；确认无误再用 `--force` |
| 部署脚本说 wasm 只有 11 KB | 用错 Emscripten（本机发行版的 3.1.6）编出了空程序，用 `tools/emenv.sh` 里的 3.1.69 重建 |
| `edgeone` 说项目类型不对 | 只有**直接上传**类型的项目能被 CLI 更新；Git 集成建的项目不行 |
| 部署看着成功、线上却没变 | 项目名写错了，CLI 另外**新建**了一个项目（脚本会警告 `CREATED a new one`），去控制台核对名字 |
| `Invalid EDGEONE_PAGES_API_TOKEN` | token 过期、复制不全，或用的是另一个站点的 token（国内站和国际站不通用） |
| 部署成功但浏览器里还是旧页面 | `worker.js` / `app.js` 被浏览器缓存，Ctrl+Shift+R 硬刷新 |
| `verify_deployed` 说 `.wasm` 不是 `application/wasm` | `edgeone.json` 的 headers 没生效（没随包上传，或被控制台规则覆盖） |
| 命令里的 token 出现在别处 | 脚本只用环境变量传 token，不写进命令行；`.env` 已被 `.gitignore`，别手工 `git add` |

**WASM 和原生不一致** → 一定是平台差异。已经踩过三个：
MSVC 的 `%s` 是宽串而 glibc 是多字节；路径大小写与反斜杠；
musl 的 `vswprintf` 遇到非 ASCII 就截断。**跨平台改动必须两边对拍。**

---

## 附：红线

1. **参考实现的代码、二进制、原版游戏素材一律不提交进仓库或产品**
   （`reference_impl/`、`CNCMaps/`、`webapp/render/`、`webapp/mg_engine.*`、`build/` 都在 `.gitignore`）
2. **产品是纯静态前端**：没有后端，不接收上传，用户素材不离开本机
3. 生成必须确定：相同参数 + 相同种子 → **逐字节相同**
4. **每一行都要能指出出处**；指不出出处的代码不许留在产品里
5. CNCMaps 是 **GPL v3**——分发编译产物就必须向用户提供对应源码
