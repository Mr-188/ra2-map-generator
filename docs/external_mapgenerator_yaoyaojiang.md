# 外部参考：`yaoyaojiang/MapGenerator`（西木随机地图生成器复刻）评估

> ## ★ 重大更正（后一阶段实测推翻本文第四节的两个结论）
>
> 本文写作时我**没有把它跑对**，据此得出了"它没做出来 / 输出是平沙加黑梳齿"的结论。
> 那个结论是**错的**，根因是**我的实验环境缺了 `Tile资源/` 目录**（它从 838 个 TMP 里
> 读图块的字节级元数据；缺了就整套 tile 选择失效）。当时我并不知道这一点。
>
> 后续用 `engine/`（本项目自己的 C++ MIX 读取层）+ `engine/src/win32/`（Win32 垫片）
> 把它**未修改地**跑起来，补齐 `Tile资源/` 之后，输出是**一张正常的地图**：
>
> ```
> tools/verify_oracle.py
>   extract  494 theater tiles, 6.6 MB
>   run      110371 B  md5=8b650e5b17f385be
>   determ.  same seed, byte-identical map
>   decode   13005 cells: water=6436, terrain=3797, clear=1784, shore=988
> ```
>
> 渲染出来是带海岸、地形、树、矿的完整岛屿，**没有黑梳齿**。
>
> 因此：
> - 第四节「**B. 用它当 oracle** — 本机不可行」**已作废**。现在**可行**，见
>   `engine/build_oracle.sh` + `tools/verify_oracle.py`，而且它是**逐字节可复现**的
>   真值来源。
> - 第四节「A. 只作参照（推荐）」不再是首选 —— 有了可运行的 oracle，路线改为
>   **照它重写 C++ 算法**（见 `engine/README.md`）。
> - 第二节「5. 它自己最后也在调海岸/砖件，和我们卡的是同一类问题」**仍然成立**，
>   但那不等于它做不出来。
> - 本文所有"它的输出是坏的"的表述**一律以本更正为准**。
>
> 教训记在 `AGENTS.md` 的口径里：**否定性断言要有阳性对照**。我这次是"跑起来了、
> 但输入不全"，比纯粹的"搜不到"更难发现 —— 它不报错，只是静默降级。

调查日期：本会话（账本前沿 §12677 之后）。
调查方式：`github.com` 直连不通（`curl` 15 s 无响应），改走 `api.github.com`（200）
取元数据与文件树，再逐个取 blob 到 `/tmp/mg_src/` 本地判读。

---

## 一、它是什么（事实，非印象）

| 项 | 值 |
| --- | --- |
| 仓库描述 | 「西木随机地图生成器复刻」 |
| 语言 / 形态 | C++，MSVC x64，`MapGenerator.sln` + WinRT GUI（`wWinMain`） |
| 创建 / 最后推送 | 2026-09-28 / **2026-10-05**（共 **11** 个提交，之后就停了） |
| 体量 | 1050 个文件、23.6 MB；`MapGenerator/*.cpp,h` 共 **29 850 行** |
| 许可证 | **无**（默认保留所有权利） |
| 关注度 | 6 stars / 1 fork |
| 关键副产物 | `x64/Release/MapGenerator.exe`（518 KB，已编译）、`x64/Debug/*.pdb`、`.ida-mcp/atan.json` |

**方法学**：`.ida-mcp/` 目录（IDA Pro + MCP 自动化）说明它是**用反编译器逐函数导出**的，
不是照 OpenTS/OpenRA 改的。源码里带 **185 个 `sub_XXXXXX` 原函数地址标注**，并且注释里
写明 RNG 消耗、字段偏移、逐指令语义 —— 与 `AGENTS.md` 要求的移植口径同源。

子系统划分（每个文件抬头都列了 `sub_XXXXXX` 对照表）：

```
MapGen.cpp            2024 行   顶层 / GenerateTerrain
MapGenMakingSub.cpp   4658 行   砖件盖章（最大）
MapGenRiver.cpp       4204 行   河流 + 水体平滑（FloodFill/CleanupTile/SelectShoreTile）
MapGenStartpoint.cpp  3417 行   出生点 / RandMap 设置
MapGenHills.cpp       1292 行   丘陵
MapGenLAT.cpp         1265 行
MapGenMapFile.cpp     1221 行   .map / .yrm 写盘（IsoMapPack5）
MapGenRecalc.cpp      1219 行   剧场 / INI 重算
MapGenRegion.cpp/MapGenTiberium.cpp/MapGenLake.cpp/MapGenTech.cpp/MapGenRadar.cpp …
```

**运行前提**：README 只有两行 —— 要把 `rmgmd.ini`、`snowmd.ini`、`temperatmd.ini`
拷到 exe 旁；代码里还要 `rulesmd.ini`、`artmd.ini`、`Tile资源/*.tem|*.sno`。
即**它不是自足产品，必须在原版游戏数据旁边跑**。

## 二、它不能替代我们什么

1. **无许可证** ⇒ 代码可读、可作交叉验证，**不能抄**（没有授权条款）。
2. **把原版专有资源提交进了仓库**：`相关INI/rulesmd.ini`(712 KB)、`artmd.ini`(317 KB)、
   900+ 个 `.tem`/`.sno` TMP、甚至一个 `随机地图生成器.rar`。`AGENTS.md` 的红线是
   「不提交原版游戏资源或新的专有素材」⇒ 我们的仓库**不能**照它的做法。
3. **不是我们的交付形态**：它是 Windows x64 GUI 单机程序，没有 Web/CLI、
   没有解码器回读验收（`decode.py`）、没有 `acceptance.py` 的 6 剧场渲染不变量。
4. **本机无法运行**：`command -v wine wine64` 都是 exit 1，没有 Wine ⇒
   **不能把它当黑箱 oracle** 来比输出。仓库里也**没有提交任何 `.map`/`.yrm` 产物**
   （`Mapoutput/` 下只有 66 个诊断用 `.py` 和两个 135 KB 的中间 `.txt`），
   所以连它的输出对不对也无法离线核。
5. 它自己最后也在调海岸/砖件（`Mapoutput/temp/` 里 `coast.py`、`mark_shore.py`、
   `shorelog.py`、`terrain_verify.py`、`verify_gate.py` …），**和我们卡的是同一类问题**。

## 三、它的真正价值：对我们**当前 blocker** 的交叉核对

它最有用的地方是 `0x579b70`（我们 §12677 卡住的那个 mask）。我用**本机反汇编**做仲裁，
不采信它的说法本身。

### 3.1 先证实它没瞎写：`0x58c2a0` 是 80 字节 work 记录的坐标查表

```
58c2a0: movswl 0x2(%ecx),%eax        ; y
58c2a4: imul   0x89c2dc,%eax         ; * width
58c2ab: movswl (%ecx),%ecx           ; x
58c2ae: add    %ecx,%eax             ; idx = y*width + x
58c2b0: mov    0xabed10,%ecx         ; work 数组基址
58c2b6: lea    (%eax,%eax,4),%eax
58c2b9: shl    $0x4,%eax             ; idx * 80
58c2bc: add    %ecx,%eax
58c2be: ret
```

⇒ 返回 `[0xabed10] + (y*width + x)*80`。与它 `WorkCell`（80 B、`data[16]`、`Byte(74)`）的
文档一致，也与我们 `rmg_cliff_transitions.py:455` 的 "base + (y*width + x)*0x50" 一致。

**⇒ 我最初的假设（我们把 `+0x4A`/`+0x40` 挂错了对象）被推翻。** 我们确实把
`terrain_4a`(+0x4A)、`transition_marker`(+0x40) 挂在 `[0xabed10]` 平表记录上
（`rmg_ts.py:327-348` 自己写明了「flat record table's `+0x38` (`[0xabed10]`)」）。
两边模型相同。

### 3.2 `0x57b210` 的门序两边一致

```
57b257..57b271   菱形四比较，出界 -> 0
57b27f..57b2b0   mode 0 走 0x486380（传入的 game cell）；mode 1 读 [cell+0x38] 水窗口
57b2bc           eax = 0x58c2a0(&coords)
57b2cc           mov 0x4a(%eax),%cl / test / jne 继续，否则 return 0
57b2df           mov 0x40(%eax),%eax / test / jge 0x57b42b 返回 memo
```

参考仓库 `TileNeighbourMask` 的写法（`work.Byte(74)==0 → 0`；`work.data[16]>=0 → memo`）
与之逐条对应（74 = 0x4A、64 = 0x40 = `data[16]`）。**这一环我们没有分歧。**

### 3.3 ★ 真正的分歧：`0x579b70`（我们 §12677 的 blocker）

参考仓库的实现（`MapGenMakingSub.cpp`）：

```cpp
if (workCells_[x + size_.workSide * y].Byte(74) == 0) return 0;   // ← 是 0x58c2a0 的那个门
const int level = cell->Level;
for (d = 0..7) {
    if (!CellExists(nx, ny)) continue;
    const MapCell* n = CellAt(nx, ny);
    if (n->Level != level + 4) continue;        // ★ 恰好高一级 = +4
    if (IsCliffFamilyTile(n)) continue;         // 0x4863D0
    mask |= kBit[d];                            // N 0x80 NE 0x01 E 0x02 SE 0x04 S 0x08 SW 0x10 W 0x20 NW 0x40
}
```

我用反汇编核了 `0x579b70` 的入口，**确认它走的是同一个 work 记录门**：

```
579bd6: lea 0x30(%esp),%ecx
579bda: call 0x58c2a0
579bdf: mov 0x4a(%eax),%cl
579be2: test %cl,%cl
579be4: je 0x57a0af              ; ← 门不成立直接 0
```

两条结论：

**(a) 我们的 `_make_mask_of`（`rmg_ts_pipeline.py:1832-1859`）缺这个 `+0x4A` 门。**
它只做 `levels.get(cell)` / `on_cliff_set` / `levels[neighbour] == base + CELL_HEIGHT`。
这是保真度缺口（会多算 bit）。

**(b) 更关键 —— §12677 的因果方向是反的。**
mask 是**从 level 算出来的**（`neighbour.Level == level + 4`）。level 全平 ⇒ mask 必然恒 0。
所以「mask 恒 0」不可能是「高度场塌掉」的根，它是**同一个根的下游**。
§12677 那条

```
mask 恒 0 ⇒ 从不 raise ⇒ +0x11b 停在 0 ⇒ 高度场是平的
```

在 `mask = f(level)` 这一步上是**自环**：两边互为前提，谁都不会先动。

**参考仓库给出的差分点**：它的 `MapCell` 只有**一个 `Level` 字段**，
`CliffMask` 读它、`0x5792dd` 的 raise 写它、丘陵/坡件也用同一个。
而我们移植里 `_make_mask_of` 读的 `levels` 与 `raise_level` 写的**不是同一个对象**：

- `rmg_ts_pipeline.py:2538` 先用 `grid.heights` 建 `levels`（2544 建了一版 `mask_of`，**随即被覆盖**）
- `rmg_ts_pipeline.py:2551-2554` 再用 `grid.record(cell).terrain_level_11b` 重建 —— 这一版才是活的
- `rmg_ts_pipeline.py:4241-4246` 的 `raise_level` 写 `terrain_level_11b`

即：`grid.heights` 与 `terrain_level_11b` **两个 level 字段并存**，
而 `rmg_ts_pipeline.py:4235-4240` 我们自己的注释已经写明：

> The port keeps **two level fields** — the reference's `+0x11b` … and its own
> `grid.heights` … and they are **not the same scale of truth yet; unifying them is
> the open item**, not a blind mirror.

参考仓库说明：官方**没有两个**，只有 `CellClass+0x11b` 一个。
⇒ 「统一两个 level 字段」就是 §12677 的真正下一步，而且可以**一次修两处**
（`_make_mask_of` 缺的 `+0x4A` 门顺手补上）。

## 四、建议（待用户裁决，不擅自改路线）

三条路，互斥：

| 路线 | 说明 | 代价 |
| --- | --- | --- |
| **A. 只作参照（推荐）** | 把 `docs/external_*.md` 当第二意见，用它核我们的反汇编读数；立刻做「统一 level 字段 + 补 `+0x4A` 门」 | 零法律风险；但与它同速，不提速 |
| **B. 用它当 oracle** | 跑它的 exe 比输出 | **本机不可行**（无 Wine）；且需原版 INI/TMP；无 `.map` 产物可离线比 |
| **C. 改用它的 C++ 引擎** | 换掉我们的 Python 核 | 无许可证 ⇒ 不可发布；Windows-only；丢掉 Web/CLI/解码器/验收；`AGENTS.md` 的素材红线 |

**本轮不改任何生成逻辑**（总览性质）。下一步建议：按 A 走 §3.3 的差分点，
它直接打在 §12677 这条主线上。

## 五、口径提醒

- 本文所有关于 `gamemd.exe` 的陈述都来自本机 `objdump`（VA 起址、`/home/hz/RA2MD/gamemd.exe`），
  不是转述参考仓库的注释。参考仓库的注释只用来**选择看哪几个地址**。
- 「本机无法运行它的 exe」是**否定性断言**，依据是 `command -v wine wine64` 均 exit 1；
  未做阳性对照（本机没有可用的 Windows 运行器可对照），此项仅供路线判断，不作技术依据。
