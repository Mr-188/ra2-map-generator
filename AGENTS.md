# RA2/YR 地图生成器 + 渲染器（C++ → WASM，纯前端）

浏览器里**生成并渲染** RA2/YR 随机地图。**没有后端，不打包任何游戏素材** ——
一切从玩家自己的游戏目录读，全部在本机完成。

---

## 目录

| 路径 | 作用 | 提交？ |
|---|---|---|
| `engine/` | C++ 引擎，原生 + Emscripten 双目标 | ✅ |
| `webapp/` | 前端页面（单页 HTML + Worker） | ✅ |
| `tools/` | 验收脚本与工具链脚本 | ✅ |
| `maptools/` | Python 格式层，**仅作验收 oracle** | ✅ |
| `reference_impl/` | 参考 RMG 实现（无许可证）与 CNCMaps 源码 | ❌ 本机对照 |
| `CNCMaps/` | .NET 渲染器的预编译发布包 | ❌ 本机对照 |
| `build/` | 构建产物 | ❌ |

## 引擎分层

```
src/crc32.h         文件名 → 32 位 CRC（MIX 索引里没有文件名）
src/blowfish.*      头解密（Westwood 公钥派生）
src/mix.*           嵌套 MIX 解析、按哈希查名、覆盖顺序（md 版胜出）
src/byte_source.*   ByteSource 抽象：文件 / 内存 / 浏览器 File 切片
src/ini.*           Windows GetPrivateProfile* 语义
src/extract.*       从游戏目录提取生成器要的散文件树
src/win32/          Win32 垫片：让参考 RMG 实现以散文件方式跑，不碰 MIX
tools/mgconsole     命令行驱动（原生）
tools/wasm_entry    浏览器入口
```

**核心设计**：参考实现只读散文件，所以我们的做法是**提取一次**成它的布局，
垫片因此只需处理普通文件操作，永远不需要理解 MIX。Emscripten 复用同一棵树。

`ra2.mix`(269 MB) 与 `ra2md.mix`(195 MB) **不进 MEMFS** —— 浏览器里由 Worker 里的
`FileReaderSync` 按需切片读。

---

## 红线

1. **参考实现的代码、二进制、原版游戏素材，一律不提交进仓库或产品。**
2. **产品是纯静态前端**：没有后端，不接收上传，用户素材不离开本机。
3. 生成必须确定：相同参数 + 相同种子 → **逐字节相同**的地图。
4. 输出必须能被本项目重新读取。
5. **每一行生成/渲染逻辑都要能指出出处**；指不出出处的代码不许留在产品里。

---

## 验收

```sh
sh tools/verify_all.sh
```

八套，全绿才算过：

| 套件 | 证明什么 |
|---|---|
| `verify_mix` | C++ MIX 层与 Python oracle 逐字节一致（35 项） |
| `verify_extract` | 提取的散文件树覆盖归档里所有被请求的 tile |
| `verify_oracle` | 参考管线出图，同种子逐字节可复现，且结构不退化 |
| `verify_wasm` | WASM 与原生**逐字节相同** |
| `verify_render` | 散文件树渲染结果与用游戏 MIX 渲染**逐像素相同** |
| `verify_webapi` | 浏览器入口契约，含 worker 的摊平 + 渲染流程 |
| `verify_uicontract` | 页面与 worker 的消息词表一致 |
| `verify_browser` | **真实浏览器**里页面能生成 + 渲染 |

**任何一条红了都不许往下走。** 加了新逻辑就加新套件，不要只靠肉眼。

---

## 构建

```sh
sh engine/build_oracle.sh                                  # 原生（需要 reference_impl/）
sh -c '. tools/emenv.sh && sh engine/build_wasm.sh'        # Node 目标，用于对拍
sh -c '. tools/emenv.sh && sh engine/build_web.sh'         # 浏览器目标（会暂存进 webapp/）
sh engine/build_render_web.sh                              # 浏览器渲染器（CNCMaps → wasm）
```

Emscripten 不在机器上：`tools/fetch_emscripten.sh` 无 root 取，
`tools/emenv.sh` 接上（`.emscripten` 的 `FROZEN_CACHE` 与 `/usr/bin` 路径都要覆盖）。

---

## 工作方式

- **每条命令都 `timeout`**，单次目标 30 s。跑不完就切块。
- **证据必须来自实际执行**，不许凭记忆引用数字。
- **平台差异会静默改结果，跨平台改动必须两边对拍。** 已踩过三个：
  - MSVC 的 `%s` 是宽串，glibc 是多字节（要 `%ls`）；
  - 路径大小写敏感 + 反斜杠 vs 正斜杠；
  - **musl 的 `vswprintf` 在 `"C"` locale 下遇到非 ASCII 就截断** ——
    曾让 WASM 版每一条剧场 tile 路径都落空，图小 25%，而**不报任何错**。
    （现在 `swprintf_s` 是自己实现的 `formatWide()`，不依赖任一 C 库的 locale 行为。）
- **浏览器产物不能带 `node` 环境**：`import { createRequire } from 'module'` 会让
  worker 在浏览器里直接死掉，按钮永远是灰的。`build_web.sh` 暂存时会检查。
- 失败要**看得见**：页面必须把引擎的错误显示出来，不许静默禁用按钮。

---

## 版本控制

**拉取和推送一律走 SSH**，不用 HTTPS：

```
origin  git@github.com:Mr-188/ra2-map-generator.git
```

- `gh` 也用 SSH：`gh auth status` 应显示 `Git operations protocol: ssh`。
  若显示 `https`，改回来：`gh config set git_protocol ssh --host github.com`
- 新克隆：`git clone git@github.com:Mr-188/ra2-map-generator.git`
- **不要**用 `https://github.com/...` 形式的远程，也不要让任何脚本去拼 HTTPS URL。

原因：这台机器上 HTTPS 到 GitHub 不稳定（会话里遇到过超时和连接重置），
而 SSH 在 22 端口和 `ssh.github.com:443` 上都实测可用。

**唯一例外**是 CI/托管服务的构建脚本——它们在自己的环境里跑，用不到本机密钥。
