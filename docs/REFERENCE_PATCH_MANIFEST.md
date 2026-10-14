# 移植侧改动清单（供生成 engine/reference_patches/ 用）

`reference_impl/` 是 gitignore 的（`.gitignore:20`），所以**所有移植侧改动只存在于本机**。
这份清单由源码里的 `[移植侧...]` 标记自动抽取生成，用来：

1. 在没有原始上游源码的机器上，仍然能知道"我们改了哪些文件、哪些位置、为什么"；
2. 在有原始上游源码的机器上，按此逐处重新生成 `engine/reference_patches/` 并做
   「解压 → 打补丁 → diff 为空」的回环校验。

> 行号为生成时的行号（2026-10-13 第二轮；TB 黑块那三处在 MapGenHills.cpp:1046/1374
> 与 MapGenMakingSub.cpp:4265），上游文件若有变动需按上下文定位。
> 标记之外还有少量无标记的移植侧改动（例如岸件兜底跳过源片自己），生成补丁时应以
> `diff -u <原始上游> <本机 reference_impl>` 的结果为准。


## `engine/src/mirror.h`

- **L573**  // [移植侧] 纯 180° 旋转：(x, y) -> (W'+H'-x, W'+H'-y)。  
  //  
  // 之前用的是"带奇偶错位的旋转"，理由是纯旋转不是整个菱形的双射。实测（W'=79,H'=88）：  
  //   · 纯旋转：落在菱形外 78 格，**相邻关系破坏 0**（它是格的同构）；

## `reference_impl/src/MapGenerator/MapGen.cpp`

- **L814**  // [移植侧] 对称：把形状做成**对称**，就在此刻。  
  //  
  // 到这里形状刚定型：IsoTileTypeIndex 是陆/水标记（水 = waterTileIndex_），  
  // Level 是海拔，Height 为 0，而任何带朝向的地形美术都还没有铺 —— 段 4 的
- **L832**  // [移植侧] 对称：把岛的生长标记清掉，再画海岸线。  
  //  
  // 段 2 的岛屿生长给每座岛占到的格子盖了归属标记（work 单元 data[14] = genCode），  
  // 而段 4 的整图海岸上妆第一步 FloodFill 里有一步"外来水体"判定：

## `reference_impl/src/MapGenerator/MapGen.h`

- **L470**  // [移植侧] Symmetry applied to the finished map, right before the writer runs.  
  // None is the default and leaves every existing map byte-identical: the pass  
  // consumes no RNG and only runs when this is not None. See MapGenSymmetry.cpp  
  // for what is mirrored and what is deliberately not.
- **L1480**  // [移植侧] 对称：一片斑块盖过的格子 + 它盖之前的瓦片号。旧值留着，是因为镜像那一片  
  // 若有一格不是占位格（在它上面盖就等于把生成器为高度落差选好的美术打穿），整片要能回滚。  
  struct BlobStamp
- **L1490**  // [移植侧] 对称：把一片刚盖好的斑块（它盖住的格子集合）整体镜像盖过去。斑块是  
  // "一组格子 + 同一个无朝向的瓦片号"，所以镜像那一片就是它的镜像，不需要再跑一次  
  // 生长 —— 实测生长会分叉（见 MapGenLAT.cpp 的说明）。镜像那一片若有一格不是占位格，  
  // 这一片**整片回滚**（两半都没有，保持对称，也不打穿现成的美术）。返回镜像盖了几格。
- **L1504**  // [移植侧] 第 4 次属性重算之后、写盘前，按最终格属性剔除放错位置的树  
  // （TREE01..25，不含 TIBTRE 矿树）：水面格、真悬崖墙格（CliffSet /  
  // WaterCliffs）、以及 0xFFFF 多格片覆盖格上的树一律删除；坡（RampBase /  
  // CliffRamps / RampSmooth）上的树保留。同时让出生点周围少放树。
- **L1510**  // [移植侧] 第一阶段：镜像**形状**。调用点：GenerateMapBody 之后、  
  // GenerateTerrain / GenerateSpecialTerrain 之前，三个驱动同一处。  
  //  
  // 形状在这个时刻只由三样东西构成（读 GenerateMapBody, MapGen.cpp:697 得出）：
- **L1524**  // [移植侧] 内陆 / 山地（LandType 3、4）专用：这两个类型不走 GenerateTerrain，  
  // 地形由 GenerateSpecialTerrain 在其上挖河与湖而成，而且它是边挖边铺艺术，所以  
  // 没有"形状已定、艺术未铺"的时刻可以挂钩。做法是把权威半场的格子**整体复制**  
  // （载荷与艺术一起，多格片走 MirrorTile、SlopeIndex 反射），再让
- **L1533**  // [移植侧] 只镜像**海拔字段**：用在 MakeRegions 里"区域函数已定海拔、而任何  
  // 依赖海拔的美术还没选"的那个窗口内（FixCliffLevels / PlaceCliffs /  
  // CorrectCliffTiles / CreateHills / CreateLATs / RecalculateCellAttributes 全在其后）。  
  // 这样后面的阶段会在对称的海拔上自己选出对称的美术 —— 而"末尾才复制"会错位露缝
- **L1542**  // [移植侧] 收尾修补：到最后仍然对不上的那几对镜像格整格搬平（海拔 + 美术，美术过  
  // MirrorTile）。只动**本来就不一致**的格（内陆图实测 13005 对里 28 个），不是整半场  
  // ——整半场事后搬被实测否决过（2.09%~2.61% 露黑），原因见该函数头。只做左右对称；  
  // 180 那条 16% 的地板在 mirror.h 里有记录。不设对称时直接返回。
- **L1548**  // [移植侧] 只镜像 **overlay 层与建筑标记**（矿片不带朝向，逐值搬运是精确的）。  
  // 调两次：驱动里 AddTiberium 之后、CreateHills 之前 —— CanHostSlope 读的正是  
  // OverlayTypeIndex 与 AltFlags，不平掉它们 CreateHills 就会在两半做出不同判断；  
  // 以及 MirrorMap 里再调一次，覆盖其后新摆上去的东西。
- **L1556**  // [移植侧] 第二阶段：镜像**摆上去的东西**。调用点：PruneTerrainTrees 之后、  
  // Cleanup 之前，三个驱动同一处。  
  // 放在这里的理由：ComputeRadarImage 与写盘都在其后，雷达与 [Header] 因此  
  // 自动重算，不需要单独镜像。
- **L1570**  // [移植侧] 格点是否落在任一出生点的净场 6x6 内（出生点 2x2 居中、外扩  
  // 2 格）。出生点在 AddTiberium / CreateLATs 之前已确定，树、岩石生成时  
  // 用它避让，而不是事后改地形。  
  bool IsStartClearArea(int x, int y) const;
- **L1574**  // [移植侧] 矿石/矿柱净场 10x10（出生点 2x2 居中、外扩 4 格）。  
  bool IsOreClearArea(int x, int y) const;
- **L1626**  // [移植侧] 180 对称的"缝墙"：河流不许跨过 x = (mapWidth + mapHeight) / 2 这条分界。  
  // 开河发生在形状镜像之前（WinMain.cpp:509 GenerateSpecialTerrain，522 GenerateTerrain  
  // 里的 MirrorShape），而 MirrorShape 是把权威半场 (x < (W+H)/2) 复制到镜像半场。一条  
  // 跨缝的河因此会被**从缝上切断**：留在权威半场的那截保留，另一截被替成对应格的 180
- **L2127**  // [移植侧] The full footprint - columns AND rows - of whichever multi-cell  
  // family the tile belongs to (ShorePieces 42, CliffSet 40, WaterCliffs 28,  
  // DestroyableCliffs 2, the four 4-wide waterfall sets), or false when the tile  
  // is not a member of any of them (i.e. it is a single 1x1 piece).
- **L2139**  // [移植侧] The [Map] LocalSize top the visible rect is written with.  It is 5  
  // for an unmirrored or left-right map and 6 for a 180-degree one, because the  
  // vanilla usable-area test (MapGenMakingSub.cpp:4084-4088, the trailing +2 in  
  // its second clause) makes the rectangle asymmetric: measured over five map
- **L2150**  // [移植侧] The piece a mirror of `kind` turns `tile` into, with *inoutHeight  
  // rewritten to the same sub-cell's offset inside the new piece.  Returns -1  
  // when the tile is not a multi-cell family member, or when no piece with the  
  // mirrored footprint exists - the caller reports that rather than writing a
- **L2157**  // [移植侧] 对称：把某个随机抽签的**取值**换成镜像伙伴在同一点上的取值。  
  // 调用方照常抽（随机流与 --symmetry 0 完全不受影响），只有值被替换 —— 于是两半的  
  // 纹理/植被决策是"同一随机输入下的对应输出"。site 是抽签点编号（不按次数配对，  
  // 避免两半抽签次数不同时错位）。
- **L2343**  // [移植侧] 对称：每个权威侧岸格记下自己的 roll，镜像格沿用同一签（见 SelectShoreTile）。  
  // 放进成员而不是文件级 static：浏览器 worker 会连续生成多张图，必须逐张清空。  
  std::map<uint32_t, int> shoreRoll_;

## `reference_impl/src/MapGenerator/MapGenHills.cpp`

- **L77**  // [移植侧] 对称：这两个标记是 CanHostSlope / CliffMask 的输入，而它们读的瓦片在两半是镜像的。  
  MirrorWorkMarks(config_.symmetry);   // [port-only]
- **L82**  MirrorElevationGrid();       // [移植侧] 施加之后再次转置（这一步自己写角值与 touched）  
  FinalizeElevationSlopes();   // 0x5a36c1  sub_6B3850
- **L259**  // [移植侧] 对称：只算权威半场，另一半在 pass A 之后整体镜像过去。  
  //  
  // The field is built by a directional recurrence (height += west; height += north),  
  // and a left-right mirror swaps exactly those two directions, so the recurrence IS
- **L313**  // [移植侧] 对称：非权威格不跑递推，pass A 之后从镜像格取结果。  
  if (!canonical(x, y))
- **L412**  // ---- [移植侧] 对称：把权威半场的结果镜像到另一半（在 pass B 取整之前）----  
  if (symmetric)
- **L500**  // [移植侧] 对称：同一张表在左右转置下的对应项，即  
  //     (c0, c1, c2, c3) -> (c0, c3, c2, c1)  
  // 从一个格子的角值模式得到它镜像格的模式。表在这条置换下是闭合的（1<->2、3<->4、  
  // 6<->8、10<->12、14<->16，其余自对应）—— 这也是 --diag-symmetry 打印的 SlopeIndex
- **L510**  // [移植侧] 对称：**180°** 的对应项。同一条推导法（角模式表 kSlopeCorners 在镜像下的  
  // 置换），只是 180° 旋转的角置换是  
  //     (c0, c1, c2, c3) -> (c2, c3, c0, c1)  
  // 而不是转置的 (c0,c3,c2,c1)。逐项查表得：
- **L553**  // [移植侧] 对称：镜像半场的格子拿的是**镜像片**，而 tileMorphable_ 是按片索引  
  // 查的、在镜像下并不封闭（早先实测：LR 下 Shore 缺 2 片、180 下 CliffWater 缺 4 片）。  
  // 直接问会得到与权威半场不同的答案，CanHostSlope 于是只在一侧为真，  
  // FinalizeElevationSlopes 便只在一侧更新海拔。所以这里把镜像片映射回权威侧那张片
- **L672**  // [移植侧] 对称：网格播种后先转置一次，让 ApplyElevationLevels 读到对称的角值。  
  MirrorElevationGrid();
- **L1018**  // [移植侧] 对称：镜像对共享这一次判定。  
  //  
  // Everything this step reads is symmetric by the time it runs: the elevation  
  // grid was transposed by MirrorElevationGrid, and the protection marks
- **L1046**  // [移植侧/实测否决] 上下对称**不能**走这条成对判定，尽管它也是反射。  
  //  
  // 角块（2x2 格点）与格不是同一张格子：左右对称是转置 (x,y)->(y,x)，块映到块的  
  // **同一锚点**；上下对称是反对角翻转 (x,y)->(k-y,k-x)，块映到的是 (k-y-1,k-x-1)  
  // 那个块的锚点 —— 差一格（块跨 x..x+1，而反射中心落在格点上）。所以"把权威格的  
  // 角模式置换一下写给镜像格"给出的坡向与镜像格自己的角块对不上。  
  //  
  // 实测（内陆 size2 players2 seed 20260913，`--stop-after hills: FinalizeElevationSlopes`  
  // 之后整图渲染；判据：纯黑像素 / ≥150px 黑块 / 可见区族别不一致）：  
  //     成对（kSlopeCornerMirror180） 305976 / 1194 / 122   ✗  
  //     成对（改用左右那张转置表）     465028 /  638         ✗  
  //     独立判定（现在这条）              474 /    0 / 503  
  // 全程（完整管线）：329232 / 1089 → 63406 / 28（左右对称同一把尺 45583 / 14）。  
  //  
  // 2026-10-13 之前的记录把 TB 与 LR 归为"同类反射、可共用成对判定"，依据是族内一致率  
  // （51.8% → 49.8%）：那个指标对"片错但同族"不敏感，换成渲染纯黑块后结论是反的。  
  // 180 同样排除（它是旋转，角格同样错位，另有实测记录）。  
  const int kKindOk = (config_.symmetry == mg::MapSymmetry::AxialLeftRight);
- **L1185**  // [移植侧] 对称：镜像对共享这一次判定（见函数头）。The mirrored cell takes  
  // the SAME level, and the slope whose corner pattern is this one's transpose  
  // (kSlopeCornerMirror); the tile follows from that index, so the image half  
  // gets the mirrored ramp piece rather than a second, independent decision.
- **L1255**  // [移植侧] 对称：锚点只由权威半场提供，镜像块跟着一起盖章（见下面那段）。  
  // 与 FinalizeElevationSlopes 一样：LR 与 TB（同为反射）成对处理，180 排除。  
  int pairX = 0, pairY = 0;
- **L1339**  // [移植侧] 对称：块判定同样是按镜像对共享的。The four cells of the block and  
  // their mirror images are stamped together, and the image-side anchor is  
  // skipped above, so a block cannot merge on one half only.  Without this the  
  // 0xFFFF erase lands on one side: measured on the gate's Inland map, 1313 px
  // of black at one anchor whose mirror cells were fine.
- **L1374**  // [移植侧/修 TB] 镜像格必须按**本格自己**的对称映射求，不能写死转置。  
  //  
  // 这里原来写 (y+dy, x+dx) —— 那是左右对称的镜像；上下对称的镜像是 (k-y, k-x)，  
  // 于是 TB 上那 4 格的 0xFFFF 抹除与 Level+1 全落到了**别的格子**上（`--diag-hills`  
  // 实测：改前 MergeSlopeBlocks 一步 levelBad 71→175、markerBad 71→116；改后 71→71）。  
  // 左右对称下两者恒等，行为不变。  
  int pmx = 0, pmy = 0;

- **L793**  // [移植侧/修 TB] 上下对称原来**不**走这里，而是走下面那段"岛屿做法"…
  // （把 712 格岸件全换成普通地面）。重新实测后作废：岸族足印闭合度与左右对称一致
  // （都 40/42），引擎 MirrorTile 能配到精确对应件，抹掉的代价是整张图没有海岸。
  // 现在 `kind == AxialLeftRight || kind == AxialTopBottom` 共用这条"卸妆 -> 成对重选"。
  if (kind == mg::MapSymmetry::AxialLeftRight
- **L867**  // [移植侧/修 TB] 已删除：上下对称的"岛屿做法"（岸片 -> 普通地面）。
  // 保留这段注释是为了说明"为什么这里空着"：不要再把它加回来。
- **L380**  `RepairIncompleteShoreInstances()` 的调用点（MirrorMap 末尾、MirrorDivergedCells
  之后）。**只能在管线最后**：重选那一趟末尾查不到破损（那时内存里还完整）。
- **L1003**  `void RandomMapGenerator::RepairIncompleteShoreInstances()` —— 收尾修补本体。
  检出"半片"（2x2 的片只剩 1~2 格，实测 34 处全在镜像半场）并把**整片**还原成卸妆前那一份
  （`shoreBackup_`）。实测 44 个半片格 -> 还原 88 格 -> 写出来 0 个半片，黑像素总数不变。

## `reference_impl/src/MapGenerator/MapGenRiver.cpp`

- **L3292**  // [移植侧/修 TB] TileFootprint 增加 `unsigned long long* outMask`（默认 nullptr）。
  // 收尾修补要拿足印位图才能判断"这一片是否完整"；w/h 不够，位图不是满格的片会误判。
  bool RandomMapGenerator::TileFootprint(int tile, int* outCols, int* outRows,
                                         unsigned long long* outMask) const

## `reference_impl/src/MapGenerator/MapGen.h`

- **L2137**  // [移植侧/修 TB] TileFootprint 的 outMask（见 MapGenRiver.cpp）。
- **L2345**  // [移植侧/修 TB] `shoreBackup_`：岸族卸妆前的 (片号, 片内偏移)，按 packed
  // MapCoords 存，留到最后的收尾修补用；每张图清空（浏览器一个实例连续生成多张图）。
  std::vector<std::pair<int, std::pair<int, int> > > shoreBackup_;
- **L2349**  // [移植侧/修 TB] `void RepairIncompleteShoreInstances();`

- **L68**  // [移植侧] 缝墙的**轴**跟着口味走：`RiverSeamAllows(x, y)` 在
  Rotational180 下挡 x、在 Rotational180Alt 下挡 y（两者的权威分界线分别是 x=k/2 与 y=k/2）。
  挡错轴 => 河湖落在被镜像覆盖的那一半 => 整张图 water 0 / shore 0（实测）。
- **16 处**  权威半场判据 `x < mx || (x == mx && y < my)` 全部改为
  `mg::AuthoritativeXY(config_.symmetry|kind, x, y, mx, my)`（MapGenHills.cpp 6、
  MapGenSymmetry.cpp 9、MapGenMakingSub.cpp 1、MapGenRiver.cpp 1）。新口味只在
  `engine/src/mirror.h` 里改一行；现有四种逐字节不变。

- **L3436**  // [移植侧] MirrorTile 的 kind 白名单改用 `mg::IsRotation180(kind)`：
  // 写死 `Rotational180` 时，180 的另一种半场在这里直接吃 -1（"无对应件"），于是镜像半场
  // 的岸件**一片都不转向**（turned 实测 0，180 是 270），渲染出来是"镜像那侧的湖没有湖岸
  // 裙边、只剩硬锯齿边"。足印变换（L3447 的 `tw/th/tmask`）本来就把非 LR/TB 归到"旋转
  // 180"，与新口味一致，所以这一处就是全部。

- **L3281**  // [移植侧] `TileFootprintCells(tile, outCells[][2], maxOut)`：足印里**被占用的**
  (col,row) 集合，行序——就是 `PlaceIsoTile` 盖章时走的那一组。光有 `TileFootprint` 的
  w/h 不够：41/42 两片不是矩形，要知道"哪几格"才能补一件没盖完的片。（作者：用户家庭分支
  `109b137`，本轮融合。）
- **L2326**  // [移植侧] `RepairIncompleteShorePieces` 那一段（镜像 pass 末尾、`placed:` 日志前）：
  给每件**自己**剩下、仍是占位的足印格补上（`Height = col + row*w`）。成因是 `PlaceIsoTile`
  按行序写，撞上别人占的格就中途 `return false`，已写的不回滚、没写到的留在占位（渲染成
  Clear01）。**只写占位格、绝不覆盖已有美术**；放最后是因为更早的占位格状态是
  InitRegions/CreateHills/CreateLATs 的输入（实测早处补会改掉 9487/13005 格的输入）。
  实测：新模式 4 件 5~8 格被补完；TB 在本机参数下 0 处（它已经不会留下占位缺口）。

## `engine/src/mirror.h`（本仓库自有）

- **L311**  `Rotational180Alt = 4`：与 `Rotational180` **同一个格映射**，只换权威半场
  （`x < k/2` → `y < k/2`），因此图上分界线从"右上→左下"变成"左上→右下"。
- **L620**  `AuthoritativeXY(...)`：那 16 处的单点来源。
- **L636**  `IsRotation180(kind)`：凡是"180 专属行为"（水/岸方向表、缝墙、可用带补偿）都问它。

## `reference_impl/src/MapGenerator/MapGenLAT.cpp`

- **L241**  // [移植侧] 对称：随机抽签取值的镜像共享。见 MapGen.h 的说明。  
  // 调用方先照常抽签（own），再把值送进来；镜像侧返回伙伴在**同一个抽签点**上的值。  
  // ---------------------------------------------------------------------------  
  double RandomMapGenerator::MirrorSharedValue(double own, const MapCell* c, int site)
- **L314**  // [移植侧] 对称：斑块盖章是按栅格顺序在中心周围铺的，所以即使"中心点"镜像对称，  
  // 盖出来的区域也不是镜像的（实测：一格进入 LAT 判定时已是沙地 493、它的镜像格还是 0，  
  // 判定于是分叉）。改成"盖一处、同时在镜像中心盖同一处"，三个数量减半保持密度。  
  // 本函数只被调用一次，减半不会重复生效。
- **L349**  // [移植侧] 对称：斑块 = 一组格子 + **同一个无朝向的瓦片号**（PlaceBlob 把  
  // tileIndex 原样盖在该集合的每一格上），所以镜像那一片就是这一片格子的镜像，  
  // 不需要（也不该）再跑一次生长。实测过"再跑一次"：生长是按"到种子的距离 + 抖动"  
  // 的优先堆，前两对斑块能对上，第三对 31 格里就差了 4 格 —— 分歧累积成整图
- **L456**  // [移植侧] 对称：落点是"全局随机槽号"，两半本来互不成对（这正是地面纹理不对称的  
  // 主要来源）。改成"撒一处、同时在镜像格撒同类型"，并把目标数量减半以保持密度。  
  const bool symPlant = (config_.symmetry != mg::MapSymmetry::None);
- **L499**  // [移植侧] 出生点净场 6x6 内不放这种随机地面 overlay（168..177，  
  // FA2 里表现为沙地上的碎石/土堆，即用户在 (109,111) 看到的"岩石"）。  
  // 跳过本格继续重抽，不影响别处 overlay 数量目标。  
  // 科技建筑地基格同样不铺：地基上不能有任何覆盖物。
- **L716**  // [移植侧] 已测并否决：试过"树斑成对撒 + 预算减半"。PlaceGreenPatches 在引擎里  
  // 被**调用两次**（vanilla 内联两遍），减半因此执行了两次 -> 树少了一半，图整体变了，  
  // 指标反而变差（岛屿 21.2%->21.9%、内陆 39.8%->41.1%），所以撤回。  
  remaining -= ScatterTrees(CellAt(chosenX, chosenY), F2I64(count), size);
- **L722**  // [移植侧] 对称：同一片也在镜像格撒一份（同尺寸、同数量）。落点是全局随机槽号，  
  // 两半本来互不成对，这是地面/植被纹理不对称的一处来源。  
  // 注意做法：**不减半**，而是把镜像那次撒下的树也计入预算 —— 密度因此不变，也就不必  
  // 依赖"只减半一次"（本函数在引擎里被调用两次，上次减半被执行两次、树少了一半）。
- **L791**  // [移植侧] 岩石种子不选在出生点净场 6x6 内。  
  if (IsStartClearArea(x, y))
- **L794**  // [移植侧] 岩石种子不选在科技建筑地基上（扩散时对地基格另有  
  // 拦截，见 PlaceBlob；种子本身在扩散循环外，必须在这里挡掉，  
  // 否则岩石地砖会直接盖到建筑下）。  
  if ((cell->AltFlags & AltCellFlags_ContainsBuilding) != 0)
- **L818**  // [移植侧] 对称：岩石斑块同样"盖一处、镜像那一片"，理由与 ScatterLATBlobs  
  // 里的一致（再跑一次生长不保证落在镜像集合上）。ScatterRocks 没走那个 lambda，  
  // 所以在这里单独做一次镜像盖章。出生点净场与建筑地基的避让是镜像对称的谓词，  
  // 所以被镜像的那一格集合仍然是合法落点。
- **L827**  symRock ? &stampedRocks : nullptr);   // [移植侧] 岩石避开出生点  
  if (symRock)
- **L959**  // [移植侧] 岩石 blob 不盖出生点净场格，也不盖科技建筑地基格（扩散  
  // 候选在下面的邻居循环里已排除地基格，但种子格不在候选循环内，要在  
  // 这里一并挡住）。跳过盖章但继续扩散邻居。  
  const bool stampBlocked
- **L984**  // [移植侧] 岩石 blob 不把净场格纳入候选，岩石不会漫进出生区。  
  if (avoidStartClear && IsStartClearArea(nx, ny))
- **L1007**  // [移植侧] 对称：斑块按"到种子的距离 + 随机抖动"的优先堆生长 —— 距离镜像不变，  
  // 但抖动是随机的，于是镜像那份长成**不同形状**（实测：一格进入 LAT 判定时已是  
  // 沙地、镜像格还是 0，判定分叉）。把抖动按**格**共享：镜像格拿到同一抖动，距离  
  // 又相同，优先级完全一致，斑块于是长成精确镜像。抽签照抽（随机流不变），只换取值。
- **L1283**  size_t removedBuilding = 0;   // [移植侧] 压在科技建筑地基上的地形对象  
  DiagLog("TREE-PRUNE-BASE water=%d shore=%d waterCliffs=%d",
- **L1296**  // [移植侧] 最高优先级：任何地形对象（树、TIBTRE 矿柱，不论  
  // 种类）都不允许压在科技建筑地基上。各生成阶段已有避让，这里  
  // 是写盘前的最后一道兜底。  
  if (c != nullptr
- **L1353**  // [移植侧] 最后兜底：科技建筑地基格上不允许残留任何 overlay（矿石、  
  // 碎石 LAT 等）。各生成阶段已直接避让，这一遍只清除漏网之鱼，并记一条  
  // 日志便于发现"避让失效"的路径。  
  if (cellSlots_ != nullptr)

## `reference_impl/src/MapGenerator/MapGenMaking.cpp`

- **L81**  // [移植侧] 对称：区域函数刚定完海拔，而崖/坡/岸的美术都还没选 —— 就在这里把  
  // 权威半场的海拔复制过去，后面那些阶段便会为对称的海拔自己选对称的美术。  
  if (!MirrorLevels(config_.symmetry))
- **L88**  // [移植侧] 对称：再平一次海拔。FixCliffLevels 是这一串里**最后一个只写海拔**  
  // 的阶段 —— 它之后 PlaceCliffs 就开始把海拔变成美术（崖片的 Height 与所在格  
  // 的海拔绑在一起）。上面那次 MirrorLevels 在它之前，所以它把两半又拉开了：  
  // 实测 MakeRegions 跑完有 7 对镜像格海拔不同，而它们正是内陆图中间那道两级
- **L95**  // [移植侧/两次实测否决] 试过把这条（FixCliffLevels 之后再平一次海拔）开给上下对称：  
  // 总类别率 49.5% → 52.6% 更差，且 ramp→land 从 1286 涨到 1369 —— 因为这一条是  
  // **整半场抄海拔**，而 TB 的海拔分歧本来就大，抄完会把**已经盖好的坡/崖美术**与海拔  
  // 弄脱节。LR 之所以需要且无害，是因为它在铺崖前只差 7 对海拔。已撤回，TB 保持不开。
- **L99**  // [移植侧/实测无改善] 给上下对称也开这条：`after MakeRegions` 的 levelBad 仍是 75 ✗  
  // —— 说明 MirrorLevels 只覆盖"可用带"内的格子，这 75 对不在它的作用范围里。  
  // 已知事实：TB 的 levelBad 在 MakeRegions 这一趟从 0 跳到 75（FixCliffLevels 把两半  
  // 拉开），而 LR 在同一趟保持 0。已撤回，TB 保持不开（LR 的行为不变）。
- **L111**  // [移植侧/本轮实测结论] FixCliffLevels 的 ∓4 修正分支是**方向相关**的（east/west/cell），  
  // 镜像半场走不同分支 → 实测 `--stop-after regions` 的 TB z 差分布恰为 ⟨-4:75, +4:75⟩（LR 为 0）。  
  // 试过两处事后抄平：① 紧跟 FixCliffLevels 之后（那时两半已相等，抄 0 格 ✗）；  
  // ② MakeRegions 末尾（抄 75 格、regions 后 z 差归零 ✓）—— 但**可见区类别不一致 1502→1519 没改善** ✗，

## `reference_impl/src/MapGenerator/MapGenMakingSub.cpp`

- **L4265**  // [移植侧/修 TB] 上下对称时**成对铺**：本格与它的镜像格各铺一次。  
  //  
  // `PlaceCliffs` 第 2 趟是 TB 整条链上**唯一**制造"镜像对不一致"的地方（用逐阶段门  
  // `--stop-after regions` + `MG_STOP_REGION=<趟名>` 量出来：这一趟之前 levelBad/markerBad  
  // 都是 0，这一趟之后 150 = 75 对，而 CorrectCliffTiles / RepairCliffPieces /  
  // FillGreenPlaceholders 其后每一趟都一个都不改）。做法与其它成对判定一致：每对只从  
  // 权威格发起，镜像格随后用**镜像的掩码**走同一棵树（`CliffMask` 读的邻居海拔在此时是  
  // 对称的，掩码本就互为镜像）。只认 TB，LR/none 不变。  
  //  
  // 实测（同一张图；纯黑 / ≥150px 黑块 / 可见区族别不一致）：不开 63406 / 28 / 503，  
  // 开启 55304 / 21 / 274。共享同一次 roll、末尾 MirrorDivergedCells 收尾修补等  
  // 替代方案都实测过，见 docs/SYMMETRY_STATUS.md §4。  
  const bool cpaired = config_.symmetry == mg::MapSymmetry::AxialTopBottom
- **L4109**  // [移植侧] 对称：一对镜像格只抽一次签。  
  //  
  // This function is deterministic apart from its two DrawZeroOrOne() calls, and by  
  // the time it runs the state it reads (the cliff masks, the neighbouring tiles) is
- **L4672**  // [移植侧] 对称：填绿这一步用 rng_.Next() 随机挑 pending 里的格子，两半本来各挑各的  
  // —— 这正是"第一次真差异"（--diag-symmetry 实测：跳过本函数后 MakeRegions 的  
  // crossFam/markerBad 都是 0）。改成"挑一格、同时在镜像格填同一张绿地瓦片，并把镜像格  
  // 的邻居也并入扩散队列"，于是两半的填绿过程完全同步；目标数量减半以保持总量。
  //  
  // 更正确认（2026-10-13 第二轮，逐阶段门）：MakeRegions 里第一处差异**不是**这里，而是  
  // `PlaceCliffs` 第 2 趟；本函数跑完时 levelBad/markerBad 与它跑之前一模一样（150/150）。
  // [移植侧] 这里只做"同步"不做"搬平"，所以差异仍留到 CreateHills 才被放大。

## `reference_impl/src/MapGenerator/MapGenRiver.cpp`

- **L68**  // [移植侧] 180 缝墙 —— 见 MapGen.h 里 RiverSeamAllows 的说明。  
  static constexpr int kRiverSeamMargin = 2;   // 与缝线保持 2 格的余量
- **L164**  // [移植侧] 180：抽到的起点若落在镜像半场，把它**反射**到权威半场，流向随之转  
  // 180°。反射不重新抽签，所以随机序列与 vanilla 一字不差 —— 河以外的地形不受影响。  
  // （指定起点的支流分支不反射：它的起点是调用方给的，反射会改变它的含义；那边由  
  // 开挖处的缝墙兜底。）
- **L248**  || !RiverSeamAllows(F2I64(cx)))          // [移植侧] 180 缝墙  
  break;
- **L281**  if (CellExists(X, Y) && RiverSeamAllows(X))   // [移植侧] 180 缝墙  
  {
- **L1244**  continue;                              // 0x59eb42 (+[移植侧] 180 缝墙)  
  int variant;
- **L1620**  if (!RiverSeamAllows(tx))                      // [移植侧] 180 缝墙  
  continue;
- **L2036**  // [移植侧] The mark this reads (work data[14]) describes WHICH island/patch grew  
  // the cell.  One hit here returns false, and SmoothWaterBody turns that into  
  // "skip the cleanup and both shore passes" - so a stale mark costs the whole  
  // coastline (measured: the symmetric Archipelago map had 0 shore cells).  The
- **L2219**  // [移植侧] 对称：镜像半场不自己抽签，改用镜像伙伴那一格的 roll 去走同一棵官方决策树。  
  //  
  // 地形已经对称，所以每格的 8 方向连通掩码本来就是镜像对应的；两半唯一的差别是哪次  
  // roll 落在谁头上。镜像格沿用伙伴的 roll，决策树就给出"同一随机输入下的对应输出" ——
- **L3245**  // [移植侧] The visible rect's top as written to [Map] LocalSize and used by the  
  // [Header] rectangle.  See the declaration in MapGen.h for the measurement behind  
  // the one-row shift a 180-degree map needs.  
  int RandomMapGenerator::VisibleTop() const
- **L3250**  // [移植侧] 纯 180° 旋转（(x,y) -> (W'+H'-x, W'+H'-y)）是绕格心的真旋转：可见矩形  
  // 在它下面映射到**自己**，不再需要那一行补偿（那是老的"错位映射"留下的）。  
  // verify_symmetry 的 band 检查现在断言 u5 -> u5。  
  return 5;
- **L3256**  // [移植侧] The footprint of whichever multi-cell family the tile belongs to.  
  // This is FindFamilyFootprint with the family bases bound to this instance; it  
  // exists because the symmetry pass has to know the footprint's ROWS as well as  
  // its columns to transpose a covered cell's Height (see MapGen.h).
- **L3272**  // [移植侧] The piece a mirror turns this tile into, and the Height the same  
  // sub-cell carries afterwards.  Returns -1 when the tile is a single 1x1 piece  
  // (nothing to do) or when no piece with the mirrored footprint exists (nothing  
  // safe to do - the caller reports it rather than writing a piece whose mask does
- **L3303**  // [移植侧] 海岸片的"外围水向"信息表 —— 对称件靠查表找，不靠撞第一个。  
  //  
  // 出处（实测）：把多张生成图里的每个海岸片**实例**聚成整体（同片号且八连通），取"该片  
  // 足印外围八方向是否有水"，按片号统计。样本 8 张图（温带 6 + 雪地 2；land 3/4、size 1/2/3、
- **L3345**  // [移植侧] 风格偏好表：水向吻合的候选往往不止一个，取哪一个？  
  // 出处（实测）：对每片先筛"足印转置 + 水向吻合"的全部候选，再用渲染接近度  
  // |渲染(P) − 水平翻转(渲染(Q))| 挑最像的（图库 28 片两两矩阵）。实测平均 36.9 -> 32.4  
  // （省 12%：片 39 省 20.6、32 省 16.6、40 省 16.0、31 省 15.9）。0 = 无偏好。
- **L3380**  // [移植侧] 180 的斜坡方向映射。  
  //  
  // 斜坡族（INI [General] RampBase -> TileSet "slope"，20 片）的片号与坡向一一对应：  
  // `MapGen.h:1452` 与 `MapGenHills.cpp:1158` 都写着  tile = rampBaseIndex_ + SlopeIndex - 1，
- **L3432**  // [移植侧] 每种对称有自己的足印变换：左右=转置；180=旋转 180；上下=反对角翻转。  
  const bool transpose = (kind == mg::MapSymmetry::AxialLeftRight);
- **L3458**  // [移植侧] 对称：同族里若有多片共用这个转置足印，先按"外围水向"挑、再按风格偏好二级挑。  
  // [移植侧/修差一] 这里原来是 `tile > shorePieces_`，把岸族的**第一片**（tile == 基址，  
  // 也就是 Shore01.tem）排除在剖面搜索之外 —— 于是 #1 落到下面"取表里第一个同足印件"的  
  // 通用回退，镜像侧写成 #2（用户实测"01 的镜像本该是 17/18/19，结果放了 02"）。
- **L3459**  // [移植侧/修差一] 这里原来是 `tile > shorePieces_`，把岸族的**第一片**（tile == 基址，  
  // 也就是 Shore01.tem）排除在剖面搜索之外 —— 于是 #1 落到下面"取表里第一个同足印件"的  
  // 通用回退，镜像侧写成 #2（用户实测"01 的镜像本该是 17/18/19，结果放了 02"）。  
  // 同样的差一让候选筛选把 #1 也排除，于是 #17 只能配到 #2。改成 >= / <。
- **L3469**  // [移植侧] 修正：180 必须用 180 的剖面置换。之前这里无论 kind 都用转置的  
  // MirrorWaterProfile，于是 180 挑出的"对应件"足印对、朝向错 —— 镜像侧岸线走样  
  // 的根源。数据层核对：42 片里 38 片存在"足印+剖面都对"的 180 对应件。  
  const bool rot180 = (kind == mg::MapSymmetry::Rotational180);
- **L3475**  // [移植侧] 180 试过"按候选集分组、组内同序对应"的配对表（从表的等距平移结构推出来），  
  // **实测没有改善**（#34↔#38 的水面掩膜 IoU 仍 0.01、整图中位 0.423→0.424、肉眼 A/B 无差别），  
  // 已撤回：那套指标对多格件不可靠，没有可靠测量就不改。180 这里保持"无偏好 → firstCand"。  
  const int prefer = rot180 ? 0 : kShoreMirrorPreference[srcIdx];
- **L3490**  // [移植侧] 180：这里曾经加过一条"没有精确对应件就取剖面最近的候选"  
  // 的替换（针对 42 片里唯一没有 180 伙伴的 #4/#20）。**已实测否决并撤掉**：  
  // 那两片互为最近件但并不互为 180 旋转（同格实例的水掩膜 IoU 只有  
  // 0.31~0.43），替换之后镜像侧画出一块硬边的矩形沙滩，用户一眼就看出来了；
- **L3550**  // [移植侧] 180：**跳过源片自己**。这条回退是"剖面搜索失败"后的兜底（同足印、不看  
  // 剖面），它按表序返回第一个同足印件 —— 而 1×2 里第一个永远是 #4，于是 #4 的镜像格  
  // 又拿到 #4（等于没换，用户看到的就是"另一边仍然放着 04"）。跳过自己之后 #4 只能落到  
  // #20、#20 落到 #4 —— 正是用户看素材判断的对称关系（Shore04.tem ↔ Shore20.tem）。
- **L4157**  // [移植侧] 对称：一对镜像格只抽一次签。  
  //  
  // This stage is the FIRST asymmetry after the carve-time copy, and the per-stage  
  // probe says so: entering it the cells are exact, leaving it 394 of 6952 mirrored

## `reference_impl/src/MapGenerator/MapGenSymmetry.cpp`

- **L1**  // MapGenSymmetry.cpp - [移植侧] the symmetry passes.  
  //  
  // This is OUR code, not the reference implementation's: the vanilla random map  
  // generator has no symmetry option at all, so there is no disassembly address to
- **L284**  // [移植侧] 已测并否决：纹理级"整半场镜像"（把 1x1 单格瓦片从权威半场镜像过来）。  
  //  
  // 动机仍然是那个差距：官方手绘对称图（画面竖中线为轴，左半 vs 右半翻转）12.1 / >20 19.3%  
  // / 暗像素 0.09%，我们当前 20.3 / 40.4% / 0.05%，差在 20~60 那段纹理。
- **L301**  // [移植侧] 已测并否决：把权威半场的**逐格瓦片数据整份镜像**到对面（整半场镜像）。  
  //  
  // 动机：官方手绘对称图在同一把尺子（以画面竖中线为轴，左半 vs 右半翻转）上是  
  // 平均差 12.1、差异>20 占 19.3%、暗像素 0.09%；我们当前是 20.3 / 40.4% / 0.05%。
- **L315**  // [移植侧] 海岸的镜像化到这里为止（本 pass 不再动岸片）。三层都量过：  
  //  
  // 1) 选片层：两半的岸片是同一张片（数据层 (片号,片内偏移) 完全一致）——也就是"海岸只做  
  //    一次决定"，任何缺陷都不会只出现在一侧。这是 SelectShoreTile 的 roll 镜像共享做到的。
- **L516**  // ---- [移植侧] 非左右对称：水面统一成同一张 1x1 水片（子帧 0） ----------------  
  // 用户的观察：非左右对称时"水块没铺对称"。查下来确实如此 —— 水族里 314..321 是 2x2 片  
  // （四块纹理不同、相位在 180/上下这类映射下必翻面），而复制路径是**逐格照抄**，于是镜像  
  // 水格上的"片+子帧"只有 29.3% 与权威侧相同（左右对称是 64%、仅片同 97%）。
- **L683**  // [移植侧] 岸族交还给生成器自己的镜像感知选择：SelectShoreTile 已让镜像半场用  
  // 镜像伙伴那一格的 roll 走同一棵官方决策树，选出来的片就是"同一随机输入下的对应  
  // 输出"（形状与变体都对应）。这里若再按"形状转置"覆盖一次，反而打散那份对应关系  
  // —— 实测两者同时开着时，roll 共享对最终图完全没有影响。
- **L688**  // [移植侧] 对称：只搬形状，不搬"为另一个形状选的海岸美术"。  
  // 水格 -> 基础水片；岸件（shorePieces_ 族）-> 占位格。两半随后一起由官方那套  
  // SmoothWaterBody 重新上妆（见本函数末尾），于是每一格的岸片都是照着**现在这个  
  // 对称形状**选的。--symmetry 0 不经过这里。
- **L692**  // [移植侧] 对称：只搬形状，不搬"为另一个形状选的海岸美术"（仅左右对称）。  
  // 水格 -> 基础水片（水沿细节交给 DecorateWaterTiles）、岸件 -> 占位格；两半随后一起  
  // 由官方那两趟选片 pass 成对重上妆（见本函数末尾）。180 保持原样：它的镜像关系是  
  // 绕中心的 180° 旋转，"照着自己形状选片"这条路线在它上面不成立（实测成对盖章 139 次
- **L714**  // [移植侧] 180 的岸片交给 MirrorTile 选对应件 —— 它现在按 **180 的剖面置换**  
  // 挑（MapGenRiver.cpp 的 Rot180WaterProfile）。数据层核对：42 片里 38 片存在  
  // "足印+剖面都对"的 180 对应件（缺 3、19 与 40/41）。原样复制只会把"为另一个  
  // 形状选的朝向"搬过去，镜像半场因此走样。
- **L862**  // ---- [移植侧] 上下：岛屿做法（岸片 -> 普通地面） ------------------------------  
  // 第 4 轮结论：这套 tileset 没有按"反对角翻转"画的岸片美术（足印闭合、美术不闭合），  
  // 所以靠映射做不出与权威侧一致的上下海岸。用户为 180 认可过的"岛屿做法"正好绕开它：  
  // 岸片族换成普通地面（逐格均匀美术，不需要任何"上下关系"），水格与水面一瓦不碰 ——
- **L1028**  // [移植侧/实测否决] 试过对 180 也开放本函数（LR 一直靠它把斜坡族整格抄到镜像侧）。  
  // 结果**明确更差**：同一张内陆图上"自己配自己"的斜坡格 102 → 758，多伙伴源片仍是 22/22，  
  // 而**暗像素（黑缝）0.45% → 3.58%（8 倍）**。即 180 的格映射不是 8 邻域自同构（对角邻居  
  // 互换），整格拷贝会把为另一个对角形状选的艺术搬过去 → 撕缝。已撤回，180 保持不开放。
- **L1034**  // [移植侧] 上下对称（反对角线）与左右对称同属**反射**，格映射保持邻域，所以这趟  
  // "整格抄家族不同的对"对它同样适用（180 是旋转，实测会撕黑缝，仍然排除）。加上它之后  
  // TB 的逐格随机美术（LAT/草地/沙地变体）才和 LR 一样被镜像过去。  
  if (kind != mg::MapSymmetry::AxialLeftRight)

## `reference_impl/src/MapGenerator/MapGenTiberium.cpp`

- **L376**  // [移植侧] 出生点净场 10x10 跳过矿石覆盖与 TIBTRE 矿柱（但仍喂邻  
  // 居，矿田会绕过净场继续生长），出生点在本阶段之前已确定。  
  // [移植侧] 科技建筑的地基格同样跳过：科技建筑在本阶段之前已经放好，  
  // 矿石覆盖或矿柱压到地基上会让建筑在游戏里无法使用/显示异常。
- **L378**  // [移植侧] 科技建筑的地基格同样跳过：科技建筑在本阶段之前已经放好，  
  // 矿石覆盖或矿柱压到地基上会让建筑在游戏里无法使用/显示异常。  
  const bool skipOverlay =
- **L443**  // [移植侧] 矿田不把科技建筑地基格纳入扩散候选，矿石不会盖到建筑  
  // 底下；地基外侧的格仍可由其他节点喂到，矿田绕着地基长。  
  if ((ncell->AltFlags & AltCellFlags_ContainsBuilding) != 0)

## `reference_impl/src/MapGenerator/WinMain.cpp`

- **L605**  // [移植侧] 瓦片全部定型后，剔除落在水面/悬崖上的树并让出生点周围  
  // 少放树（必须在第 4 次重算之后，此时多格水/崖片已铺满）。  
  rmg.PruneTerrainTrees();
