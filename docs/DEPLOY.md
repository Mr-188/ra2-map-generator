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
- [八、以后怎么更新](#八以后怎么更新)
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

# 1. Emscripten（~380 MB 的 apt 包，解到 ~/opt/emscripten）
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

# 5. 【可选】Chromium + puppeteer，用于真实浏览器自测
sh tools/fetch_chromium.sh
npm install puppeteer-core
```

> **为什么用 apt 包而不是官网下载**：微软 CDN 从国内几乎拉不动（实测 70 秒只有 4 KB）。
> 所有下载脚本都用**并行分块**，因为单条长连接会被限速到几百 KB/s。

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

✅ 八套全绿，含**真实浏览器端到端**。

```sh
sh tools/verify_all.sh
```

| 套件 | 证明什么 |
|---|---|
| `verify_mix` | C++ MIX 层与 Python oracle 逐字节一致（35 项） |
| `verify_extract` | 提取覆盖归档里所有被请求的 tile（954 个） |
| `verify_oracle` | 参考管线出图，同种子逐字节可复现 |
| `verify_wasm` | WASM 与原生**逐字节相同** |
| `verify_render` | 散文件树渲染结果与用游戏 MIX 渲染**逐像素相同** |
| `verify_webapi` | 浏览器入口契约成立，含 worker 的摊平+渲染流程 |
| `verify_uicontract` | 页面和 worker 的消息词表一致 |
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
build/webapp/        67 个文件 / 16 MB   ← 可直接部署
build/webapp.zip     5.7 MB              ← 拖拽上传用（内容在根层）
```

脚本会：

- 只拷该发布的文件（排除测试用的 `game` 符号链接和探针页面）
- 抹掉产物里烤进的**构建机路径**（Emscripten 的注释里带着 `/home/xxx/...`）
- 检查有没有残留的绝对路径或本机 URL，**有就让构建失败**

---

## 六、部署到 EdgeOne Makers（免费）

> ⚠️ **这一节的界面步骤来自腾讯官方文档，我没有账号，无法实测。** 命令行的部分我验证过。

**为什么选它**：官网写明免费版"permanently available"，包含**自定义域名**和**免费 SSL 证书**；
单文件上限 25 MB（我们最大 1.3 MB）；不用 Git，可以直接传文件夹。

### 6.1 注册并创建项目

1. 打开 <https://edgeone.ai/register>，**注册并登录**
   （官方说明：*users in China need to register and log in*，否则链接只保留 1 小时）
2. 进入 Makers 控制台 → 新建项目
3. 部署方式选 **直接上传**（Direct Upload / Drop）

### 6.2 上传

解压 `build/webapp.zip`，把**里面的内容**（不是外层目录）拖进去。
或者直接把 `build/webapp/` 目录整体拖上去。

⚠️ **必须保留目录结构**——`render/_framework/` 里有 59 个文件，拍平了就跑不起来。
上传完在控制台里看一眼，`render/_framework/dotnet.js` 这个路径要存在。

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

控制台里给 `render/_framework/*` 设置较长缓存（7 天），
`index.html` / `app.js` / `worker.js` 保持不缓存或短缓存。
`tools/deploy_cos.sh` 里有每个文件应该用的 `Cache-Control`，可以对照。

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

## 八、以后怎么更新

改完代码：

```sh
sh tools/verify_all.sh          # 八套全绿
sh tools/package_webapp.sh      # 重新打包
```

然后把 `build/webapp/` 的内容重新上传，或者推 Git 让 EdgeOne 自动构建。

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
