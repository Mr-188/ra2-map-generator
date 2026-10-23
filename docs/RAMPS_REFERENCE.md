# 坡道（ramp / slope）在外部工程里怎么做 —— 调研与可借鉴规则

> 2026-10-22。目的：为"我们的项目做出**可控对称**的坡"找依据。
> 所有结论后面都跟着可核对的位置（仓库 + 文件 + 符号）；拿不到证据的写"未找到"。

---

## 0. 一句话结论

**这套素材里，"坡"不是一种东西，是三层数据叠出来的：**

| 层 | 数据 | 谁决定它 |
|---|---|---|
| **角高** | 每个格子的四个角的高度（OpenRA 叫 cell corner height，0..N 步） | 地形生成 |
| **坡型** | 一个字节 `RampType`（1..4 主方向，5..12 细分），存在 **TMP 文件头**里 | 美术（每片图自带） |
| **图** | `slopeNN.tem`（单格坡面）、`rmpfxNN.tem`（坡沿修补）、`rampNN.tem`（多格坡道件） | 美术 |

引擎**从不"推导"坡**——它只做一件事：**看这格的四个角高，挑一片 RampType 与之匹配的图**。
所以"两边对称"的正确判据不是"片号互为镜像"，而是：

> **两边对应格的四个角高一致 → 各自挑到的那片，必然互为镜像。**

我们现在做的"片号对拷"其实是绕过了这条判据，用结果去凑，所以才会出现"片号对了、缝还在"。

---

## 1. OpenRA（现代 C# 重写，TS/RA2 素材直接可读）

### 1.1 坡型 = TMP 头里的一个字节

- `OpenRA.Game/Map/TerrainInfo.cs`，`class TerrainTileInfo`：
  ```csharp
  public readonly byte Height;
  public readonly byte RampType;
  public readonly Riser Riser;   // 四角各自的期望高度，可选
  ```
- 同一文件的 `Riser`（`this[Connection c]`）注释写明：
  > "Fetch the expected height of the given connecting corner, or null if the tile's Height value should be used instead."

  → **一片图可以自报四角高度**（Riser），也可以只说一个整体 Height。

### 1.2 坡怎么挑：四角高度 → 查表

- `OpenRA.Mods.Common/MapGenerator/RampTiler.cs`
  - `HeightMap`（`Target` / `LowerBound` / `UpperBound` / `Adjustable` / `Tileable`）——**角高**是核心数据；
  - `Constrain(AdjustmentMode)` + `GetLowerHull` / `GetUpperHull`：
    **用四次洪水填充把角高约束成"相邻角最多差 1 步"**，这是保证坡能连上的根本规则；
  - `RampTiler(Map, rampBrushes)`：
    ```csharp
    var tl = cellRamp.Corners[0].Z / heightStep;  // 左上
    var tr = cellRamp.Corners[1].Z / heightStep;
    var br = cellRamp.Corners[2].Z / heightStep;
    var bl = cellRamp.Corners[3].Z / heightStep;
    var lookup = tl | (tr << 2) | (br << 4) | (bl << 6);   // 2 bit/角 的键
    ```
    → **一片坡的身份就是它的四角高度组合**；
  - `GenerateRampsAndHeights`：每格取四角 → 减去最低角 → 若相邻角差 > 1 直接放弃整次贴图；否则用上面的 `lookup` 找候选片，**候选多于一片时随机挑**（这就是"同形状多片可互换"的官方做法）。

### 1.3 竖立面的连接高度

- 同文件 `GetConnectionHeight(height, info, connection)`：
  用 `Riser[connection]`（如果有）否则 `RampProperties.GetCorner(connection)` 算相邻角在该格上的高度，**并且 clamp 到 byte**。
  → 坡和图对不对得上，靠的是这个函数，不是片号。

### 1.4 对我们最有价值的三条规则

1. **角高是唯一真相**：先把所有格子的四角高度算对，再挑图；
2. **相邻角高差 ≤ 1**（`Constrain` 里的 hull 传播）：违反就要么抬角、要么放弃这一格；
3. **候选可随机**：同 `lookup` 的片随便挑一片，视觉等价——这解释了为什么用户说"组内任意一对都兼容"。

---

## 2. OpenRA2 / Cheesy0314/OpenRA2（RA2 移植到 OpenRA）

仓库：<https://github.com/Cheesy0314/OpenRA2>（C#，27★）

- `mods/yr/tilesets/temperat.yaml`（11524 行）把 RA2 温带 tileset 全量翻译成了 OpenRA 的 Template 格式：
  - `Template@29` = `slope01.tem`，`RampType: 1`
  - `Template@30` = `slope02.tem`，`RampType: 2`
  - … `Template@38` = `slope10.tem`，`RampType: 10`
  - **即 `slopeNN` 的 RampType 就是 NN 本身**（1..20 与 1..20 一一对应）。
- `Template@510..521` = `rmpfx01..12.tem`，**RampType 逐片核对**（脚本读 `temperat.yaml` 得出）：
  ```
  rmpfx01 02 03 -> RampType 1     rmpfx07 08 09 -> RampType 3
  rmpfx04 05 06 -> RampType 2     rmpfx10 11 12 -> RampType 4
  ```
  → **每三片同一 RampType**，正好对应 CNCMaps/原版那条 `(RampType-1)*3 + fixup` 公式（fixup = 两个对角线邻居是否平地的 2 位掩码）。
  也就是说 rmpfx 不是"坡面本身"，而是**坡面在相邻地面消失后的一种替换件**。
- 该仓库**没有** OpenRA 的 `MapGenerator/`（树里没有 `RampTiler.cs`），所以它只提供**数据层证据**，不提供生成算法。

> **这条解释了之前的争议**：`rmpfx07/08/09` 是 RampType 3，`rmpfx10/11/12` 是 RampType 4 —— **两个不同的主方向**，在左右镜像下 3 与 4 正好互换（和 `slope03↔slope04` 是同一件事）。
> 所以用户给的"07/08/09 ↔ 10/11/12"是对的，但它的实质是"**方向 3 ↔ 方向 4**"；同组的 01/02/03（都是方向 1）在镜像下应当还是方向 1，即它们之间才真正是"同方向可互换"。

---

## 3. CNCMaps（本机 `reference_impl/ccmaps-net`，我们渲染器就是它）

### 3.1 读 TMP

- `CNCMaps.FileFormats/TmpFile.cs`，`TileImageAttr.Read`：每格头里依次读
  `Height / TerrainType / RampType` 三个字节。

- **实测（2026-10-23，直接读 `build/oracle_assets/Tile资源/温和/slopeNN.tem`）**：
  这 20 个文件的头部和"标准 TMP"的字段顺序不同（RA2 的 .tem 是 13 个 int32 之后才到
  标志字），按 CNCMaps 的顺序直接解会得到 `RampType = 0` 这种假值。真正的三字节在
  `0xCDCDCDCD` 填充标记之后：
  ```
  slope01..04  -> RampType 1..4        slope06..10 -> RampType 6..10
  ```
  **坡型就是片号**，与 OpenRA2 的 `temperat.yaml` 一致。`slope05` 那次探针没命中填充
  标记（文件里没有 `0xCDCDCDCD`），属于扫描方式的偏差，不是文件异常。

### 3.2 坡沿修补（**我们渲染器里已有的官方逻辑**）

- `CNCMaps.Engine/Map/Operations.cs`，`ApplyLATRecalc` 的 `else if (t.SetNum == collection.RampBase || t.SetNum == collection.RampSmooth)` 分支（注释：*"apply ramp fixup (CellClass LAT recalc 0x47CA80)"*）：
  ```csharp
  int fixup = -1;
  switch (ti.RampType) {
    case 1: if (FlatAt(TopLeft)) fixup++; if (FlatAt(BottomRight)) fixup += 2; break;
    case 2: …TopRight / BottomLeft…
    case 3: …BottomRight / TopLeft…
    case 4: …BottomLeft / TopRight…
  }
  t.TileNum = fixup != -1
      ? GetTileNumFromSet(collection.RampSmooth, (byte)((ti.RampType - 1) * 3 + fixup))
      : GetTileNumFromSet(collection.RampBase,  (byte)(ti.RampType - 1));
  ```
  → **坡面/坡沿片的最终选择由"两个对角线邻居是不是平地"决定**，公式是 `(RampType-1)*3 + fixup`。
  这条**就是引擎原版的行为**（注释里给了地址 0x47CA80），不是 CNCMaps 自创。

### 3.3 结论

我们渲染时用的坡，**本来就会按"邻居是否平地"重新挑一次**：
如果地图数据里坡的角高/邻居和权威半场不一致，渲染出来的图就自然不一致——
**这就是"片号对了缝还在"的机制**（`VerifyRampFixup` 会在渲染时覆盖我们写进去的片号）。

---

## 4. omarelarab/ra2-engine（RA2/YR 引擎的 C++ 重写，含 Ghidra 逆向笔记）

仓库：<https://github.com/omarelarab/ra2-engine>

- `docs/re/movement-height.md`（R-210）——**最有价值的一份外部证据**，直接给出原版 `gamemd.exe` 的判定：

  > CellClass 字段：`+0x11A` Height、`+0x11B` Level、`+0x11C` SlopeIndex（**the TMP ramp type**）、`+0xEC` LandType

  高度门 `FUN_004D9B70`：

  | 高差 | 规则 |
  |---|---|
  | `diff == 0` | 允许 |
  | `|diff| == 1` | **仅当较低的那格有坡**（上坡看源格 `SlopeIndex != 0`，下坡看目标格 `SlopeIndex != 0`）才允许 |
  | `|diff| == 4` | 桥面规则 |
  | 其它 | `Move::No` —— 就是崖 |

  并给出实测统计：
  > "ALL01 terrain census … 191 one-level steps whose **lower** cell has a ramp type, 4 whose higher cell has it, **none without a ramp**"

  → **一条硬规则：相邻格高差为 1 时，低的那个格子必须带坡型，否则单位过不去。**
  这正是"坡"在玩法上的定义，也是我们生成坡时应当保证的不变量。

- `scripts/play/w8-place-slope.play`：一个用脚本把 MCV 摆到坡上的回归用例（说明他们把坡看作可被脚本复现的对象）。

---

## 5. 未找到 / 无法核对的项目

| 想找的 | 结果 |
|---|---|
| OpenRA 官方 RA2/YR 分支 | **无**。OpenRA 主仓库 `mods/` 只有 ra/cnc/d2k/ts（`mods/ts/rules/world.yaml` 有 `Ramp1..4Sequences`） |
| FinalSun / FinalAlert 2 源码 | **未找到开源仓库**（这些是 Westwood 的闭源工具）；论坛里能搜到用法说明，但没有可核对的源码 |
| WAE（World Altering Editor） | 未找到公开仓库 |
| OpenRA2 的坡道生成算法 | 未找到（该仓库不含 `MapGenerator/RampTiler.cs`） |
| `OpenRA.Mods.Common/EditorBrushes/EditorRampBrush.cs` | **该文件不存在**（jsdelivr 返回空）；编辑器里坡是通过普通图块笔刷 + `RampType` 自动推导的 |

---

## 6. 我们的项目怎么做出"可控对称坡"

### 6.1 数据来源（已经有了，只是没当唯一真相）

`reference_impl/src/MapGenerator/MapGenHills.cpp` 的 `FinalizeElevationSlopes` 里：

```cpp
const int index[4] = { indexA, indexA + 1, indexB + 1, indexB };
//  e(x,y), e(x+1,y), e(x+1,y+1), e(x,y+1)   —— 左上、右上、右下、左下
static const int kSlopeCorners[19][4] = { {0,0,0,0}, {0,15,15,0}, … };
```

- 角高来自 `elevGrid_`（每个角一个高度）；
- `kSlopeCorners[slope]` 就是 **RampType → 四角模式** 的表（0 或 15，另有 13..18 三种四级组合）；
- `slope` 找到一个值后：`SlopeIndex = slope`，`IsoTileTypeIndex = rampBaseIndex_ + slope - 1`。

**这正是 OpenRA `RampTiler` 的同构做法**，我们已经有了全套数据，只是镜像时绕过了它。

### 6.2 建议的判定条件（按优先级）

1. **角高优先**：镜像时**先把镜像半场的四个角高抄成权威半场的转置**（`(c0,c1,c2,c3) → (c0,c3,c2,c1)`，即我们已经有的 `kSlopeCornerMirror`），**再让引擎自己挑图**；
2. **不要事后改片号**：改片号会被渲染期的 RampFixup（`Operations.cs` 那条规则）按邻居重算覆盖，白改；
3. **高差 1 必须带坡**：对每条相邻格高差为 1 的边，检查**低的那个格子** `SlopeIndex != 0`（原版规则，见 §4）；不满足就补坡或改高；
4. **相邻角高差 ≤ 1**：像 OpenRA `Constrain` 那样做 hull 传播，超了就放弃该格而不是硬塞；
5. **多格坡道件（ramp01..10）单独处理**：它们的 RampType 在外层（`Template@` 缺省），靠"四角组合 + 尺寸"匹配；镜像时按**整片**搬（片号 + 格集合 + 角高），不要逐格搬。

### 6.3 验证方法（已经写好一半）

| 检查 | 工具 | 判据 |
|---|---|---|
| 片级 | `tools/verify_ramp_pieces.py` | 每片镜像 = 对手的转置整片 |
| 格级 | `tools/verify_ramp_partner.py` | 每格镜像 = 表伙伴 |
| 角高 | `tools/verify_slope_corners.py` | 镜像格四角 = 权威格四角的转置（模型图 1815/1815 通过；关掉镜像的旧路径 1698 对里 8 对不符） |
| 假坡 | `tools/corners_from_map.py` | 坡面格的角模式取自 `slopeNN` 自身的 RampType → `kSlopeCorners`。模型图 3633 个坡面格里**角模式全平的 0 个**；而"四邻整格层号相同"的统计给出 2087 —— 见下面的更正 |
| 连通 | `tools/verify_ramp_connectivity.py` | 所有高差 1 的相邻边（4394 条），低的格子必须有坡：**2 条不满足，且从原版图就存在、两边一模一样**（(104,49)/(49,104)，是崖件压在坡位置造成的） |
| 视觉 | `tools/inspector/make_inspector.py` + 渲染暗像素 | 红点 0 且暗像素不升 |

两个脚本都已在 `tools/` 里，并且**已经在模型图上跑过**：
- 角高：当前默认档 **1815/1815 通过**；把镜像关掉（`MG_CLIFF_PARTNER=0`）后 **1698 对里有 8 对不符**，190 对只有一边是坡 —— 这正是"坡面没镜像"的量化证据；
- 连通：**4394 条一级台阶里只有 2 条**低格没有坡，且这 2 条**从原版（未改动）图里就存在**、左右完全一致 —— 是崖件压住坡位置的另一个问题，不是对称造成的。

结论：**角高一致 + 连通**这两条判据在模型图上已经成立，剩下的差异是渲染层面的（见 §3.2 的 RampFixup）。

### 6.4 更正："四邻同层却带坡"不是假坡（2026-10-23 实测）

之前用"四个相邻**整格**的 `Level` 都等于自己"来数假坡，得到 2087 个。**那个统计口径是错的**：

- 引擎判断坡用的是**四角高度**（`elevGrid_`，格点上的连续值），整格 `Level` 是另一个量；
- 一个格子完全可能四角各不相同（所以是坡），而四个相邻整格的 `Level` 恰好相等 —— 这在地形被量化成整格高度时很常见；
- 用 `tools/corners_from_map.py` 按**坡片自身的 RampType**（`slopeNN` 的 RampType 实测等于 NN）反查 `kSlopeCorners`：模型图 **3633 个坡面格里角模式全平的是 0 个**。

引擎侧也有旁证：在 `FinalizeElevationSlopes` 的写坡分支上打点，"四角全平"这个条件**一次都没命中**（进入该分支的格子角高本来就不全等，角模式查不到表的格子更早就被跳过），见 `MapGenHills.cpp` 的 `slope < 0` 分支。

---

## 7. 参考链接

- OpenRA `TerrainInfo.cs`：<https://github.com/OpenRA/OpenRA/blob/bleed/OpenRA.Game/Map/TerrainInfo.cs>
- OpenRA `RampTiler.cs`：<https://github.com/OpenRA/OpenRA/blob/bleed/OpenRA.Mods.Common/MapGenerator/RampTiler.cs>
- OpenRA TS mod world（`Ramp1..4Sequences`）：<https://github.com/OpenRA/OpenRA/blob/bleed/mods/ts/rules/world.yaml>
- OpenRA2（RA2 移植）RA2 tileset：<https://github.com/Cheesy0314/OpenRA2/blob/master/mods/yr/tilesets/temperat.yaml>
- ra2-engine（C++ 重写 + 逆向笔记）：<https://github.com/omarelarab/ra2-engine> ，高度门笔记 <https://github.com/omarelarab/ra2-engine/blob/master/docs/re/movement-height.md>
- 本机 CNCMaps：`reference_impl/ccmaps-net/CNCMaps.Engine/Map/Operations.cs`（`ApplyLATRecalc` 的 ramp fixup 分支）、`CNCMaps.FileFormats/TmpFile.cs`
- 本机引擎：`reference_impl/src/MapGenerator/MapGenHills.cpp`（`kSlopeCorners`、`FinalizeElevationSlopes`）
