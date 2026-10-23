# RA2 / YR 触发器完全参考（供生成器使用）

> 目标：让地图生成器能写出**真的会被 gamemd 执行**的触发器，并知道每个触发器/事件/动作怎么填。
> 本文所有 ID、参数类型、字段顺序都来自官方 FinalAlert 2 的触发数据库与真实随游戏发行的地图，
> 不是凭记忆抄的；出处见文末。

---

## 0. 先给结论（油田开局给谁）

**只改「开局归谁」根本不需要触发器。** `.map` 的 `[Structures]` 一行就是：

```
[Structures]
索引=房主,建筑类型,强度, rx, ry, 朝向, 标签, flag1, flag2, energy, upgradeCount, spotlight, up1, up2, up3, flag3, flag4
; FA2 文档把第 3/4 字段叫 Y/X；对应 IsoMapPack 存储坐标 rx/ry
```

第 1 个字段就是房主（房子名，来自 `[Houses]`）。官方战役图里直接这么写：

```
; MAPSMD03.MIX 里的 YR 战役图
1050320=Special,NACNST,64,82,123,0,0BE87C8C,1,0,1,0,0,None,None,None,0,0
1033035=Neutral,CAOILD,256,162,83,0,0925D83C,0,0,1,0,0,None,None,None,0,0
```

所以生成器想「油田给 Neutral / 给某玩家 / 给 Civilian」，先走这条：**改 `[Structures]` 第 1 字段**。
只有两种情况才需要触发器：

1. 多人图里要按**玩家位**（A–H）给，而不是按国家名 —— 用「中性 + 标签 + 开局触发器 + 动作 14」，
   目标房主码写 **4475–4482**（YR 的 8 个玩家位，见 §6.4）。
2. 你要的不是「开局就归谁」，而是「进入/摧毁/计时之后再归谁」。

---

## 1. 触发器到底由哪几个 section 组成

```
[Triggers]   触发器本体：ID = 房主,<none>,名字,禁用,简单,中等,困难,0
   ├─ [Events]   ID = 事件个数, 事件ID,p1,p2, 事件ID,p1,p2, ...
   ├─ [Actions]  ID = 动作个数, 动作ID,p1..p6,路径点, 动作ID,p1..p6,路径点, ...
   └─ [Tags]     标签ID = 类型(0=一次性,2=可重复),标签名,触发器ID
        ├─ [CellTags]        格子 = 标签ID                （把标签钉在格子上）
        └─ [Structures] 第7字段 / [Units] 等第7字段 = 标签ID（把标签钉在对象上）
```

规则（来自 FA2 源码与官方图）：

- **事件是 AND**：一个触发器有多个事件时，全部满足才触发（官方图里有
  `[Events] 08ED7A3C=2,11,0,0,13,0,3` 这种「全灭 + 3 秒」的组合）。
- **动作按顺序执行**，一条触发器可以挂很多动作。
- **标签类型 0 = 一次性**（触发后失效）；**2 = 可重复**（重新武装，条件再满足会再触发）。
  FA2 的 Tag 下拉里就写着 `0 - Standard` / `2 - Repeating`。
- 触发器第 4 个字段 `Disabled=1` 表示**初始禁用**，之后用动作 53「Enable Trigger」打开；
  难度位 `简单/中等/困难` 为 1 表示该难度下启用。
- 事件 8「Any Event」单独使用时会让触发器**立刻**触发；开局触发器就是这么写的。

---

## 2. 文件格式（逐节，带真实样例）

### 2.1 `[Triggers]`

```
<触发器ID>=<房主名>,<attached trigger 或 <none>>,<名字>,<Disabled>,<Easy>,<Medium>,<Hard>,<0>
```

真实样例（YR 战役图）：

```
[Triggers]
088E9F3C=YuriCountry,<none>,START!,0,1,1,1,0
0BA91B3C=YuriCountry,<none>,_Send DUMMY 1,1,1,1,1,0
```

- ID 是 8 位大写十六进制字符串（与 [Events]/[Actions]/[Tags] 的键一致）。
- 第 1 字段是**房主名**（`[Houses]` 里的名字，如 `Americans`/`Neutral`/战役图的 `Player House`）。
  它决定「trigger owner」类动作作用于谁（3 生产、6 全员猎杀、36 整族改所属、119/120 清场、125 给建筑……）。
- 第 2 字段是「attached trigger」，没有就写 `<none>`（FA2 的 Attached trigger 下拉）。
- 第 3 字段名字随便取，会显示在 FA2 列表里。
- 4/5/6/7 = Disabled / Easy / Medium / Hard，1=启用。官方图里第 8 个字段（第 5 个 flag）
  **恒为 0**，语义未在编辑器中暴露，照写 0。

### 2.2 `[Events]`

```
<触发器ID>=<事件个数>,<事件ID>,<p1>,<p2>[,<事件ID>,<p1>,<p2> ...]
```

普通事件固定 3 个 token（ID + 2 个参数）。真实样例：

```
[Events]
088E9F3C=1,13,0,0                     ; 1 个事件：13 计时，0 秒
08ED7A3C=2,11,0,0,13,0,3              ; 2 个事件：11「全灭」 + 13「3 秒」
0AEBE63C=1,1,0,9                      ; 事件 1「Entered by」：房主码 9（YuriCountry）
```

**例外**：事件 60/61（TechType）是 4 个 token，第 2 个 token 固定是 `2`：

```
0A57F46C=1,61,2,0,NACNST              ; 61「TechType 不存在」：数量 0，类型 NACNST
078C04BC=1,60,2,1,GATECH              ; 60「TechType 存在」：数量 1，类型 GATECH
```

（实现时按事件 ID 特判；解析器可以按「下一个 token == 2 就多吃一个」来兼容 FA2。）

### 2.3 `[Actions]`

**每条动作固定 8 个 token**：`动作ID, p1, p2, p3, p4, p5, p6, 路径点`。没有的参数写 `0`。

```
[Actions]
09231BFC=3,46,0,0,0,0,0,0,A,100,0,52,0,0,0,0,A,53,2,09231BFC,0,0,0,0,A
```

这一条 = 3 个动作：

```
46,0,0,0,0,0,0,A          ; 46 Lock input
100,0,52,0,0,0,0,A        ; 100 播放过场（52 = 影片序号/名）
53,2,09231BFC,0,0,0,0,A   ; 53 启用触发器（P1 固定 2，P2=触发器ID）
```

- 第 8 个 token 是**路径点**，用 FA2 的字母编码：`A`=0、`B`=1 … `Z`=25、`AA`=26 …
  （官方图里大量出现 `A`/`AA`/`CB`，所以这不是可选装饰；不涉及路径点的动作写 `A` 即可）。
- 有些动作的第一个参数是**固定常量**（FAData 里写成负数，如 `-7`）：
  例如动作 19 的 P1=7、动作 53 的 P1=2、动作 125 的 P1=10。生成时照抄。

### 2.4 `[Tags]` 和 `[CellTags]`

```
[Tags]
<标签ID>=<类型>,<标签名>,<触发器ID>

[CellTags]
<格子键>=<标签ID>
```

真实样例：

```
[Tags]
0925D83C=0,Shut Up Eva! Oil,0925E3EC
06B7570C=2,Reclaimed Refinery,08E3176C

[CellTags]
148054=043710AC
```

- `[Tags]` 第 1 个字段：`0` = 一次性（Standard），`2` = 可重复（Repeating）。
  官方图里也见过 `1`，但 FA2 只暴露 0/2，生成器统一用 0 最稳。
- `[CellTags]` 的键是**格子坐标**，打包方式和 `[Waypoints]` 完全一样（见 §2.6）。

**什么时候需要标签**：事件/动作的描述里说 attached object / attached building / this cell 的，
都必须有标签把触发器钉到对象或格子上（`[Structures]` 第 7 字段或 `[CellTags]`）；
纯时间/全局条件（8、13、14、27、28、36、37…）不需要标签，触发器自己就会跑。

**每个标签只指向一个触发器**；同一个触发器可以挂多个标签（多栋楼/多个格子共用一套动作）。

### 2.5 把标签钉到对象上：`[Structures]` 的 17 个字段

字段顺序（FA2 `CMapData::AddStructure`，MapData.cpp）：

```
房主, 类型, 强度(0–256), rx, ry, 朝向, 标签, flag1, flag2, energy, upgradeCount,
spotlight, upgrade1, upgrade2, upgrade3, flag3, flag4
; FA2 的字段名是「house,type,strength,Y,X,direction,tag,...」，
; 其中 FA2 的 Y = 存储坐标 rx，FA2 的 X = 存储坐标 ry。
```

真实样例（同一栋楼挂同一标签）：

```
[Structures]
1033035=Neutral,CAOILD,256,162,83,0,0925D83C,0,0,1,0,0,None,None,None,0,0
```

- 第 7 字段 = 标签 ID 或 `None`。
- 强度 256 = 满血（FA2 新建建筑的默认值）。
- 想给建筑换房主，改第 1 字段；想让它可被触发器改房主，在第 7 字段挂标签。

`[Units]` / `[Infantry]` / `[Aircraft]` 也是同样的「第 7 字段是标签」布局（房主,类型,强度,X,Y,朝向,标签,...）。

### 2.6 坐标：IsoMapPack 存储坐标与打包

地图里的坐标是 IsoMapPack 的存储坐标 `(rx, ry)`：记录的第 1 个 short 是 `rx`，第 2 个是 `ry`
（`rx` 最大可以到 `宽+高`，不是地图宽）。平铺/对象用的打包方式：

| section | 写法 | 例子（rx=63, ry=40） |
|---|---|---|
| `[Waypoints]`、`[Terrain]`、`[CellTags]` | 数字 `rx + 1000*ry`（低 3 位是 ry） | `40063` |
| `[Structures]` | 第 3 字段 = `rx`，第 4 字段 = `ry`（FA2 叫 Y、X） | `...,63,40,...` |

`[CellTags]` 的键和 `[Waypoints]` 的值是**同一个数字**，只是 `[CellTags]` 里写成十进制字符串：
FA2 内部用 `x*1000+y` 拼字符串，而它的 `x` 就是我们这里的 `ry`、`y` 就是 `rx`，
所以落盘后同样是 `rx + 1000*ry`。

真正容易错的是**名字**：FA2 源码里 `x` 对应存储 `ry`、`y` 对应 `rx`（因为编辑器的
显示坐标相对 IsoMapPack 存储坐标转了一次），照 FA2 变量名直译就会把两个字段写反。

### 2.7 参数编码表（事件/动作里的 p1..p6 到底写什么）

参数类型来自 FAData 的 `[ParamTypes]`；**落盘形式按类型分**（FA2 存的是下拉里显示的
「前导 token」，因为保存时会 `TruncSpace` 截到第一个空格）：

| 类型 | 落盘 | 说明 |
|---|---|---|
| 房主 | 数字码 | 规则 `[Countries]` 顺序：`0` Americans … `8` Russians、`9` YuriCountry、`12` Neutral、`13` Special；地图自加的房主从 `14` 起；多人玩家位用 **4475–4482**（A–H） |
| 队伍 / 触发器 | 8 位十六进制 ID 字符串 | 即 `[TeamTypes]` / `[Triggers]` 的键 |
| 建筑 / 步兵 / 单位 / 飞机 | 规则类型表里的 **0-based 序号**（= 列表 key - 1） | 例：`[BuildingTypes]` 里 `72=CAOILD` → 存 `71`；FA2 列表显示成 `71 CAOILD`，保存时截掉名字 |
| 建筑（动作 125 等，类型 47） | **INI 名** | 例：`125,10,YAGNTC,...` |
| 路径点 | 数字 | 该动作若还带「路径点」标记，第 8 个 token 再写字母码 |
| 音效 / 音乐 / 语音 | 名字字符串 | 例：`_Amb_UrbanMurmur1`、`A07_p01` |
| 影片 / 动画 / 粒子 / 超级武器 / 箱子 | **0-based 序号**（= 规则/art 列表 key - 1） | 例：`100,0,52,...` 里的 52 是影片序号 |
| 文本 | CSF 标签名 | 动作 11 Text Trigger |
| 全局变量 | 名字 | |
| 数字 / 资金 / 时间 | 整数 | 时间按秒（官方图里 720/600/180 这种值；实际以实测为准） |
| 科技类型（事件 60/61） | INI 名 | 前面多一个固定的 `2` token |

### 2.8 ID 怎么取

官方 ID 是 8 位大写十六进制、看起来像随机哈希。生成器建议：

- 用确定性函数（种子 + 用途 + 序号）算一个 32 位值，`%08X` 输出；
- 在同一个 section 内查重（和已有键不能撞）；
- 同一个触发器在 `[Triggers]`/`[Events]`/`[Actions]` 用**同一个 ID**；
- `[Tags]` 自己另取 ID，在第 3 字段引触发器 ID。

### 2.9 队伍 / 脚本 / AI（先别碰）

`[TeamTypes]` / `[TaskForces]` / `[ScriptTypes]` 是「刷兵」用的，结构是
「数字索引 → ID」+ 每个 ID 一个自己的 section：

```
[TeamTypes]
0=0B1DF85C
[0B1DF85C]
Name=TEAM_Player_Engineer1
House=Americans
TaskForce=...
Script=...
...
[TaskForces]
0=0DE0E41C
[0DE0E41C]
Name=TF_Player_Engineers
0=5,ENGINEER
Group=-1
[ScriptTypes]
0=0DE1003C
[0DE1003C]
Name=Engineer1_Script
0=11,11
```

`[AITriggerTypes]` 是另一套「AI 自动造兵」系统（一行 18 个字段），
`[AITriggerTypesEnable]` 用 `<ID>-G=yes` 开关。**简单玩法不需要它们**，
要用「增援」时优先用动作 7/80 + TeamTypes。

---

## 3. 完整事件表（0–61）

> 来源：FAData.ini `[EventsRA2]`（官方 FinalAlert 2 数据，YR 项已标）。
> 参数列只列非 0 的类型；`固定N` 表示这个参数必须是常量 N。
> 这 62 个就是原版编辑器/引擎认的全部事件编号，没有“隐藏编号”。

| ID | 名称 | 参数 | 说明 |
|---:|---|---|---|
| 0 | -No Event- | — | This is a null event. There is no need to ever use this in a real trigger. |
| 1 | Entered by... | P2=房主(数字码) | Triggers when an infantry or vehicle enters the attached object. Typically this trigger is attached to a building or a cell. |
| 2 | Spied upon | — | Detects when a spy has entered the attached building. |
| 3 | Thieved by... | P2=房主(数字码) | Triggers when a thief steals money from the specified house. |
| 4 | Discovered by player | — | Detects when the attached object has been discovered by the player. Discovered means reavealed from under the shroud. |
| 5 | House Discovered... | P2=房主(数字码) | Triggers when the specified house has any of its units or buildings discovered by the player. |
| 6 | Attacked by any house | — | Triggers when the attached unit is attacked in some manner. Incidental damage or friendly fire does not count. |
| 7 | Destroyed by any house | — | Triggers when the attached object has been destroyed. Destroyed by incidental damage or friendly fire doesn't count. |
| 8 | Any Event | — | When used alone, it will force the trigger to spring immediately. |
| 9 | Destroyed, Units, All... | P2=房主(数字码) | Triggers when all units of the specified house have been destroyed. Typically used for end of game conditions. |
| 10 | Destroyed, Buildings, All... | P2=房主(数字码) | Triggers when all buildings of the specified side have been destroyed. Typically used for end of game conditions. |
| 11 | Destroyed, All... | P2=房主(数字码) | Triggers when all objects owned by the specified house have been destroyed. This is the normal (destroy everyone) trigger condition for end of game. |
| 12 | Credits exceed... | P2=数字 | Triggers when the house (for this trigger) credit total exceeds this specified amount. |
| 13 | Elapsed Time... | P2=数字 | Triggers when the elapsed time has expired. This time is initialized when the trigger is created. Timer is reset whenever trigger is sprung when trigger is 'persistant'. |
| 14 | Mission Timer Expired | — | Triggers when the global mission timer (as displayed on the screen) has reached zero. |
| 15 | Destroyed, Buildings, #... | P2=数字 | Triggers when the number of buildings, owned by the trigger's specified house, have been destroyed. |
| 16 | Destroyed, Units, #... | P2=数字 | Triggers when the number of units, owned by the trigger's specified house, have been destroyed. |
| 17 | No Factories left | — | Triggers when there are no factories left for the house specified in the trigger. |
| 18 | Civilians Evacuated | — | Triggers when civilians have been evacuated (left the map). |
| 19 | Build Building Type... | P2=建筑(序号) | When the trigger's house builds the building type specified, then this event will spring. |
| 20 | Build Unit Type... | P2=单位(序号) | When the trigger's house builds the unit type specified, then this event will spring. |
| 21 | Build Infantry Type... | P2=步兵(序号) | When the trigger's house builds the infantry type specified, then this event will spring. |
| 22 | Build Aircraft Type... | P2=飞机(序号) | When the trigger's house builds the aircraft type specified, then this event will spring. |
| 23 | Leaves map (team)... | P1=固定1, P2=队伍ID | Triggers when the specified team leaves the map. If the team is destroyed, it won't trigger. If all but one member is destroyed and that last member leaves the map, it WILL spring. |
| 24 | Zone Entry by... | P2=房主(数字码) | Triggers when a unit of the dpecified house enters the same zone that this trigger is located in. This trigger must be located in a cell and only a cell. |
| 25 | Crosses Horizontal Line... | P2=房主(数字码) | Triggers when a unit of the specified house crosses the horizontal line as indicated by the location of this trigger. This trigger must be placed in a cell. |
| 26 | Crosses Vertical Line... | P2=房主(数字码) | Triggers when a unit of the specified house crosses the vertical line as indicated by the location of this trigger. This trigger must be placed in a cell. |
| 27 | Global is set... | P2=全局变量名 | Triggers when the specifed global (named in Globals.INI) is turned on. |
| 28 | Global is clear... | P2=全局变量名 | Triggers when the specified global (named in Globals.INI) is turned off. |
| 29 | Destroyed by anything [not infiltrate] | — | Triggers when attached object is destroyed, but not if it infiltrates a building/unit. |
| 30 | Low Power... | P2=房主(数字码) | Triggers when the specified house's power falls below 100% level. |
| 31 | Bridge destroyed | — | Triggers when the attached bridge is destroyed. A bridge is considered destroyed when an impassable gap is created in the bridge. |
| 32 | Building exists... | P2=建筑(序号) | Triggers when the building (owned by the house of this trigger) specified exists on the map. This works for buildings that are preexisting or constructed by deploying. |
| 33 | Selected by player | — | Triggers when the unit is selected by the player.  Use in single-player only. |
| 34 | Comes near waypoint... | P2=路径点(数字) | Triggers when the object comes near the specified waypoint. |
| 35 | Enemy In Spotlight... | — | Triggers when an enemy unit enters the spotlight cast by the attached building. |
| 36 | Local is set... | P2=局部变量 | Triggers when the specifed local is turned on. |
| 37 | Local is clear... | P2=局部变量 | Triggers when the specified local is turned off. |
| 38 | First damaged (combat only) | — | Triggers when first suffering from combat damage from combat damage only. |
| 39 | Half health (combat only) | — | Triggers when damaged to half health >from combat damage only. |
| 40 | Quarter health (combat only) | — | Triggers when damaged to quarter health from combat damage only. |
| 41 | First damaged (any source) | — | Triggers when first suffering from combat damage from any source. |
| 42 | Half health (any source) | — | Triggers when damaged to half health >from any source. |
| 43 | Quarter health (any source) | — | Triggers when damaged to quarter health from any source. |
| 44 | Attacked by (house)... | P2=房主(数字码) | When attacked by some unit of specified house. |
| 45 | Ambient light <= ... | P2=数字 | Triggers when the ambient light drops below a certain level.  Use numbers between 0 and 100. |
| 46 | Ambient light >= ... | P2=数字 | Triggers when the ambient light rises above a certain level.  Use numbers between 0 and 100. |
| 47 | Elapsed Scenario Time... | P2=数字 | When time has elapsed since start of scenario. |
| 48 | Destroyed by anything | — | Triggers when destroyed by anything what-so-ever. |
| 49 | Pickup Crate | — | When crate is picked up object the trigger is attached to. |
| 50 | Pickup Crate (any) | — | When crate is picked up by any unit. |
| 51 | Random delay... | P2=数字 | Delays a random time between 50 and 150 percent of time specified. |
| 52 | Credits below... | P2=数字 | Triggers when the house (for this trigger) credit total is below this specified amount. |
| 53 | Spy entering as House... | P2=房主(数字码) | Triggers if a spy disguised as house specified enters this. |
| 54 | Spy entering as Infantry... | P2=步兵(序号) | Triggers if a spy disguised as this type of infantry enters. |
| 55 | Destroyed, Units, Naval... | P2=房主(数字码) | Triggers when all naval units of the specified house have been destroyed. Typically used for end of game conditions. |
| 56 | Destroyed, Units, Land... | P2=房主(数字码) | Triggers when all land units of the specified house have been destroyed. Typically used for end of game conditions. |
| 57 | Building does not exist | P2=建筑(序号) | Triggers when the building (owned by the house of this trigger) specified does not exist on the map. |
| 58 | Power Full...（YR） | P2=房主(数字码) | Triggers if the specified house's power is at 100%. |
| 59 | Entered or Overflown By...（YR） | P2=房主(数字码) | Triggers when unit, infantry, or aircraft move over this cell. <THEM = House of entering unit> |
| 60 | TechType Exists（YR） | P1=数字, P2=科技类型(INI 名) | True if there are at least this many of this type, belonging to anyone |
| 61 | TechType does not Exist（YR） | P1=数字, P2=科技类型(INI 名) | True if there are none of these on the map at all.  Number doesn't mean anything. |

---

## 4. 完整动作表（0–145）

> 来源：FAData.ini `[ActionsRA2]`。`WP` 列 ✓ = 该动作要用第 8 个 token 的路径点。
> 标「TS 遗留」的在 RA2/YR 里没有实际效果（雷暴/泰伯利亚/冰之类），不要用。
> 这 146 个就是原版编辑器/引擎认的全部动作编号（Ares/Phobos 之类的扩展不算）。

| ID | 名称 | 参数（P1–P6） | WP | 说明 |
|---:|---|---|:--:|---|
| 0 | -No Action- | — |  | This is a null action. It will do nothing and is equivalent to not having an action at all. Why use it? |
| 1 | Winner is... | P2=房主(数字码) |  | The winner will be forced to be the house specified. The game will end immediately. Typically, the player's house is specified. |
| 2 | Loser is... | P2=房主(数字码) |  | The loser will be force to be the house specified. The game will end immediately. Typically, the player's house is specified. |
| 3 | Production Begins... | P2=房主(数字码) |  | The computer's house (as specified) will begin production of units and structures. |
| 4 | Create Team... | P1=固定1, P2=队伍ID |  | Creates a team of the type specified (owned by the house of this trigger). The team member are NOT automatically created however. |
| 5 | Destroy Team... | P1=固定1, P2=队伍ID |  | Destroys all instances of the team type specified. The units in those existing teams will remain and be available for recruiting into other teams. |
| 6 | All to Hunt... | P2=房主(数字码) |  | Forces all units, of the house specified, into 'hunt' mode. They will seek out and destroy their enemies. |
| 7 | Reinforcement (team)... | P1=固定1, P2=队伍ID |  | Create a reinforcement of the specified team. The members of the team WILL be created magically by this action. |
| 8 | Drop Zone Flare (waypoint)... | P2=路径点(数字) |  | Display a drop zone flair at the waypoint specified. The map will also be reaveald around that location. |
| 9 | Fire Sale... | P2=房主(数字码) |  | Cause all buildings of the specified house to be sold (for cash and prizes). Typically this is used in the final assault by the computer. |
| 10 | Play Movie... | P2=影片名 |  | Displays the specified movie (full screen). The game is paused while this occurs and resumes normally after it completes. |
| 11 | Text Trigger... | P1=固定4, P2=文本标签(CSF) |  | Display the text identified by the string file <label>. |
| 12 | Destroy Trigger... | P1=固定2, P2=触发器ID |  | Destroy all current instances of the trigger type specified. This does not prevent future instances of that trigger >from being created. |
| 13 | Autocreate Begins... | P2=房主(数字码) |  | Initiates autocreate for the house specified. This will cause the computer's house to build autocreate teams as it sees fit. |
| 14 | Change House... | P2=房主(数字码) |  | Changes owning house to the one specified for attached objects. |
| 15 | Allow Win | — |  | Removes one 'blockage' from allowing the player to win. The blockage number is equal the number of triggers created that have this action. |
| 16 | Reveal all map | — |  | Reveals the entire map to the player. |
| 17 | Reveal around waypoint... | P2=路径点(数字) |  | Reveals a region of the map to the player around the waypoint specified. |
| 18 | Reveal zone of waypoint... | P2=路径点(数字) |  | Reveals all cells that share the same zone as the waypoing specified. This yields some wierd results. Use with caution. |
| 19 | Play sound effect... | P1=固定7, P2=音效名 |  | Plays the sound effect specified. |
| 20 | Play music theme... | P1=固定8, P2=音乐名 |  | Plays the music theme specified. |
| 21 | Play speech... | P1=固定6, P2=语音名 |  | Plays the speech sound specified. |
| 22 | Force Trigger... | P1=固定2, P2=触发器ID |  | Force all triggers of this specified type to spring regardless of what it's event flags may indicate. |
| 23 | Timer Start | — |  | Start the global mission timer. |
| 24 | Timer Stop | — |  | Stop the global mission timer. |
| 25 | Timer Extend... | P2=数字 |  | Extend the global mission timer by the time specified. |
| 26 | Timer Shorten... | P2=数字 |  | Short the global mission timer by the time specified. It can never be reduced below 'zero' time. |
| 27 | Timer Set... | P2=数字 |  | Set the global mission timer to the value specified. |
| 28 | Global Set... | P2=全局变量名 |  | Set the global flag. Global flags are named in the file Globals.INI. Global flags can be either 'on/set/true' or 'off/clear/false'. |
| 29 | Global Clear... | P2=全局变量名 |  | Clear the global flag. Global flags are named in the file Globals.INI. Global flags can either be 'on/set/true' or 'off/clear/false'. |
| 30 | Auto Base Building... | P2=Activated |  | Initialize the computer skirmish mode build control to either 'on' or 'off' state. When 'on', the computer takes over as if it were in skirmish mode. (gs make sure he has a con yard) |
| 31 | Grow shroud one 'step' | — |  | Increase the shroud darkness by one step (cell). |
| 32 | Destroy attached building | — |  | Destroy any buildings, bridges, or units that this trigger is attached to. |
| 33 | Add 1-time special weapon... | P2=特殊武器 |  | Add a one-shot special weapon (as indicated) to the trigger's house. |
| 34 | Add repeating special weapon... | P2=特殊武器 |  | Add a permanent special weapon (as indicated) to the trigger's house. |
| 35 | Preferred target... | P2=Quarry |  | Specify what the trigger's house should use as its preferred target when using special weapon attacks. |
| 36 | All change house... | P2=房主(数字码) |  | All objects of one house change ownership to specified house. |
| 37 | Make ally... | P2=房主(数字码) |  | Cause this trigger's house to ally with the house specified. |
| 38 | Make enemy... | P2=房主(数字码) |  | Cause this trigger's house to un-ally (declare war) with the house specified. |
| 39 | Change Zoom Level... | P2=数字 |  | Changes the zoom out level of the player's radar map.  Use 1 for normal view, 2 for zoomed out. |
| 40 | Resize Player View... | P3=Left, P4=Top, P5=Right, P6=Bottom |  | Changes the player's viewing rectangle into the map.  Enter as:   x,y,w,h   where x,y gives the upper left corner and w,h give the width and height. |
| 41 | Play Anim At... | P2=动画名 | ✓ | Plays the specified anim in the specified cell. |
| 42 | Do Explosion At... | P2=武器名 | ✓ | Creates an explosion in the specified cell, using the specified warhead. |
| 43 | Meteor Impact At...（TS 遗留） | P2=流星大小 | ✓ | Sends a meteor at the specified cell. |
| 44 | Ion Storm start...（TS 遗留） | P2=数字 |  | Starts an ion storm sequence to run for the specified number of game frames. |
| 45 | Ion Storm stop...（TS 遗留） | — |  | End an Ion storm in progress. |
| 46 | Lock input | — |  | Disables user input. |
| 47 | Unlock input | — |  | Enables user input. |
| 48 | Center Camera at Waypoint... | P2=速度 | ✓ | Moves the tactical view to a specified waypoint. |
| 49 | Zoom in | — |  | Zooms the tactical map in. |
| 50 | Zoom out | — |  | Zooms the tactical map out. |
| 51 | Reshroud Map | — |  | Reshrouds the entire map. |
| 52 | Change Light Behavior | P2=光照行为 |  | Changes the way a building spotlight behaves. Attach this trigger to a building that casts a spotlight. |
| 53 | Enable Trigger | P1=固定2, P2=触发器ID |  | Enables the target trigger. |
| 54 | Disable Trigger | P1=固定2, P2=触发器ID |  | Disables the target trigger. |
| 55 | Create Radar Event | P2=事件 | ✓ | Creates a radar event at the specified waypoint |
| 56 | Local Set... | P2=局部变量 |  | Set the local flag. Local flags can be either 'on/set/true' or 'off/clear/false'. |
| 57 | Local Clear... | P2=局部变量 |  | Clear the local flag. Local flags can either be 'on/set/true' or 'off/clear/false'. |
| 58 | Meteor Shower At... | P2=Shower | ✓ | Creates a meteor shower around the specified waypoint. |
| 59 | Reduce Tiberium At...（TS 遗留） | P2=路径点(数字) |  | Reduces Tiberium around the specified waypoint. |
| 60 | Sell building | — |  | Sells the building attached to this trigger. |
| 61 | Turn off building | — |  | Turn off building attached to this trigger. |
| 62 | Turn on building | — |  | Turn on building attached to this trigger. |
| 63 | Apply 100 damage at... | P2=路径点(数字) |  | Applies 100 points of HE damage at location. |
| 64 | Light flash (small) at... | P2=路径点(数字) |  | Shows a small light flash at location. |
| 65 | Light flash (medium) at... | P2=路径点(数字) |  | Shows a medium light flash at location. |
| 66 | Light flash (large) at... | P2=路径点(数字) |  | Shows a large light flash at location. |
| 67 | Announce Win | — |  | Announce that player has won. |
| 68 | Announce Lose | — |  | Announce that player has lost. |
| 69 | Force end | — |  | Force end of scenario. |
| 70 | Destroy Tag... | P1=固定3, P2=标签ID |  | Destroy tag and all attached triggers. |
| 71 | Set ambient step... | P2=浮点 |  | Sets ambient light fade step value. |
| 72 | Set ambient rate... | P2=浮点 |  | Sets ambient light fade rate. |
| 73 | Set ambient light... | P2=数字 |  | Fades ambient light to new lighting level. |
| 74 | AI triggers begin... | P2=房主(数字码) |  | Start AI triggers for specified house. |
| 75 | AI triggers stop... | P2=房主(数字码) |  | Stop AI triggers for specified house. |
| 76 | Ratio of AI trigger teams... | P2=数字 |  | AI percentage of teams created for AI triggers (100 = all for AI trigger teams, 0 = all for regular teams) |
| 77 | Ratio of team aircraft... | P2=数字 |  | AI percentage of aircraft created for teams (100 = all for teams, 0 = all random) |
| 78 | Ratio of team infantry... | P2=数字 |  | AI percentage of infantry created for teams (100 = all for teams, 0 = all random) |
| 79 | Ratio of team units... | P2=数字 |  | AI percentage of units created for teams (100 = all for teams, 0 = all random) |
| 80 | Reinforcement (team) [at waypoint]... | P1=固定1, P2=队伍ID | ✓ | Create reinforcement team at special waypoint location. |
| 81 | Wakeup self | — |  | Breaks out of sleep or harmless mode so as to enter guard mode. |
| 82 | Wakeup all sleepers | — |  | Breaks all units out of sleep mode. |
| 83 | Wakeup all harmless | — |  | Breaks all out of harmless mode. |
| 84 | Wakeup group... | P2=数字 |  | Wakeup all units of specified group. |
| 85 | Vein growth... | P2=Activated |  | Control if veins grow or not. |
| 86 | Tiberium growth... | P2=Activated |  | Control if Tiberium grows or not. |
| 87 | Ice growth... | P2=Activated |  | Control if ice grows or not. |
| 88 | Particle Anim at... | P2=粒子名 | ✓ | Show particle animation at location. |
| 89 | Remove Particle Anim at... | P2=路径点(数字) |  | Delete particle anims at specified location. |
| 90 | Lightning strike at... | P2=路径点(数字) |  | A single Ion Storm lightning strike. |
| 91 | Go Berzerk | — |  | Attached object (cyborg) goes berzerk. |
| 92 | Activate Firestorm Defense（TS 遗留） | — |  | Turns on a house's firestorm defense. |
| 93 | Deactivate Firestorm Defense（TS 遗留） | — |  | Turns off a house's firestorm defense. |
| 94 | Ion-cannon strike...（TS 遗留） | P2=路径点(数字) |  | Fires Ion-Cannon at waypoint specified. |
| 95 | Nuke strike... | — | ✓ | Fires Nuke at waypoint specified from nearest edge. |
| 96 | Chem-missile strike...（TS 遗留） | P2=路径点(数字) |  | Fires Chemical missile at waypoint specified. |
| 97 | Toggle Train Cargo | — |  | Toggles state of cargo train dropping crate. |
| 98 | Play Sound Effect (Random)... | P1=固定7, P2=音效名 |  | Plays sound effect at random waypoint. |
| 99 | Play Sound Effect At... | P1=固定7, P2=音效名 | ✓ | Plays sound effect specified at waypoint specified. |
| 100 | Play Ingame Movie... | P2=影片名 |  | Displays the specified movie ingame. Player still has control of interface and units. |
| 101 | Reshroud Map At... | P2=路径点(数字) |  | Does an anti-map ping at waypoint specified. |
| 102 | Lightning Storm strike... | — | ✓ | Lightning storm owned by owner of trigger at waypoint. |
| 103 | Timer Text... | P1=固定4, P2=文本标签(CSF) |  | What text label to display with timer (i.e. actual text is in game.str). |
| 104 | Flash Team... | P1=固定5, P2=队伍ID |  | Flashes the specified team for the specified number of frames |
| 105 | Talk Bubble... | P1=固定1, P2=队伍ID |  | Displays talk bubble over unit |
| 106 | Set Tech Level (Techno)[Level]... | P1=固定9, P2=科技类型 | ✓ | Sets the specified Techno to the specified tech level. |
| 107 | Reinforcement by Chrono... | P1=固定1, P2=队伍ID | ✓ | Teleport reinforcement team to special waypoint location. |
| 108 | Create Crate... | P2=箱子类型 | ✓ | Create a Goodie Crate with specific contents at a waypoint.  You are responsible for knowing which contents are currently supported by the game. |
| 109 | Iron Curtain At... | — | ✓ | Iron Curtain Super effect at Waypoint. |
| 110 | Pause Game for (seconds)... | P2=数字 |  | This will pause the game for the specified seconds. |
| 111 | Evict Occupiers | — |  | This Action will Evict Urban Combat occupants >from the attached Building. |
| 112 | Center (Jump) Camera at Waypoint... | P2=路径点(数字) | ✓ | Moves the tactical view to a specified waypoint instantly. |
| 113 | Make side cheer | P2=房主(数字码) |  | Will make all infantry who aren't busy do their cheer animation. |
| 114 | Set Tab to (0-3)... | P2=数字 |  | Forces the sidebar to the desired tab. |
| 115 | Flash Cameo | P1=固定9, P2=科技类型 | ✓ | Flashes the Cameo for this type for this long in frames. |
| 116 | Stop Sounds At | P2=路径点(数字) | ✓ | Stops all sounds at waypoint that were started using the Play Sound At trigger |
| 117 | Play Ingame Movie (pause game)... | P2=影片名 |  | Displays the specified movie ingame. Game pauses while movie playing. Player has no control during movie. |
| 118 | Clear all smudges | — |  | Will delete all Smudge objects from the map. |
| 119 | Destroy all of... | P2=房主(数字码) |  | Kills everything of the specified house. |
| 120 | Destroy all Buildings of... | P2=房主(数字码) |  | Kills all buildings for specified house. |
| 121 | Destroy all Land Units of... | P2=房主(数字码) |  | Kills all land units for specified house. |
| 122 | Destroy all Naval Units of... | P2=房主(数字码) |  | Kills all naval units for specified house. |
| 123 | Mind Control Base of... | P2=房主(数字码) |  | The owner of the trigger will mind control the argument's base. |
| 124 | Restore Mind Controlled Base to... | P2=房主(数字码) |  | The owner of the trigger will give all buildings that were the argument's back to it. |
| 125 | Create Building At... | P1=固定10, P2=建筑(INI 名) | ✓ | Owner of the trigger will gain this type of building at this waypoint.  Overlays will be cleared and units bumped. |
| 126 | Restore Starting Technos of... | P2=房主(数字码) |  | All Buildings and units this house had at the start of the game will be recreated. Will bump units and erase Overlays. |
| 127 | Chrono Screen Effect for ... | P2=数字 |  | Will tile the screen with the full screen chrono effect for this many frames. |
| 128 | Teleport All to... | P2=路径点(数字) | ✓ | All Units of trigger owning House will teleport to Waypoint. |
| 129 | Set Superweapon Charge | P1=固定11, P2=超级武器 | ✓ | The owner of this trigger will have this superweapon charged to this percent, if they have the superweapon. Takes an int (0-100). |
| 130 | Restore Starting Buildings of...（YR） | P2=房主(数字码) |  | All Buildings this house had at the start of the game will be healed or recreated. Will bump units and erase Overlays. |
| 131 | Flash Buildings of Type...（YR） | P1=固定9, P2=建筑(INI 名) | ✓ | All buildings of this type owned by trigger owner will flash for this long. |
| 132 | Superweapon Set Recharge Time（YR） | P1=固定11, P2=超级武器 | ✓ | Changes the time (in frames) this superweapon takes to charge the next time it is reset, set, or fired. |
| 133 | Superweapon Reset Recharge Time（YR） | P1=固定11, P2=超级武器 | ✓ | Changes the time (in frames) this superweapon takes to charge back to normal. |
| 134 | Superweapon Reset（YR） | P2=特殊武器 |  | Resets a superweapon like a spy had gotten in. |
| 135 | Preferred Target Cell Set（YR） | P2=路径点(数字) |  | The owner of this trigger will aim all future targetable superweapons at this waypoint. |
| 136 | Preferred Target Cell Clear（YR） | — |  | The owner of this trigger will go back to targeting its superweapons normally. |
| 137 | Center Base Cell Set（YR） | P2=路径点(数字) |  | Owner of this trigger will consider the center of its base to be this waypoint. |
| 138 | Center Base Cell Clear（YR） | — |  | Owner of this trigger will go back to computing its center. |
| 139 | Blackout Radar（YR） | P2=数字 |  | Trigger Owner will have radar blackout for this many frames. |
| 140 | Defensive Target Cell Set（YR） | P2=路径点(数字) |  | The owner of this trigger will aim all future force shields at this waypoint. |
| 141 | Defensive Target Cell Clear（YR） | — |  | The owner of this trigger will go back to targeting its force shields normally. |
| 142 | Retint Red（YR） | P2=数字 |  | Retint the Red portion of the screen |
| 143 | Retint Green（YR） | P2=数字 |  | Retint the Green portion of the screen |
| 144 | Retint Blue（YR） | P2=数字 |  | Retint the Blue portion of the screen |
| 145 | Jump camera home（YR） | — |  | Just like hitting the 'H' key. |

---

## 5. 常用动作速查（中文）

| ID | 动作 | 怎么填 |
|---:|---|---|
| 1 | 胜利者是… | `1,0,<房主码>,...` |
| 2 | 失败者是… | `2,0,<房主码>,...` |
| 4 | 创建队伍 | `4,1,<队伍ID>,...` |
| 7 | 增援（队伍） | `7,1,<队伍ID>,...`（单位会被凭空创建） |
| 8 | 空投区信号弹 | `8,0,<路径点>,...,<字母码>` |
| 11 | 显示文本 | `11,4,<CSF标签>,...` |
| 14 | **改所属** | `14,0,<房主码>,...`（把「挂了这个标签的对象」改成目标房主） |
| 16 | 揭示全图 | `16,0,0,0,0,0,0,A` |
| 17 | 揭示路径点周围 | `17,0,<路径点>,...,<字母码>` |
| 19 | 播放音效 | `19,7,<音效名>,...` |
| 21 | 播放语音 | `21,6,<语音名>,...` |
| 23/24/25/26/27 | 任务计时器 开始/停/延长/缩短/设置 | 前 6 个参数基本是数字 |
| 32 | 摧毁挂标签的建筑 | `32,0,0,0,0,0,0,A` |
| 36 | **整族改所属** | `36,0,<房主码>,...`（触发器房主的所有物件 → 目标房主） |
| 46/47 | 锁/解锁输入 | 过场用 |
| 48 | 镜头移到路径点 | `48,0,<路径点>,...,<字母码>` |
| 51 | 重新遮罩地图 | |
| 53/54 | 启用/禁用触发器 | `53,2,<触发器ID>,...` |
| 56/57 | 局部变量 置位/清除 | |
| 67/68 | 宣告胜利/失败 | |
| 99 | 在路径点播音效 | `99,7,<音效名>,...,<字母码>` |
| 100 | 播过场影片 | `100,0,<影片序号>,...` |
| 108 | 在路径点生成箱子 | `108,0,<箱子类型>,...,<字母码>` |
| 112 | 镜头跳转 | `112,0,<路径点>,...,<字母码>` |
| 125 | 在路径点创建建筑 | `125,10,<建筑INI名>,...,<字母码>`（房主=触发器房主） |
| 129 | 给超武充能 | `129,11,<超武序号>,<百分比>,...` |

---

## 6. 配方（可直接抄）

### 6.1 开局立即执行

```
[Triggers]
0A000002=Neutral,<none>,Do Something,0,1,1,1,0
[Events]
0A000002=1,8,0,0
[Actions]
0A000002=1,16,0,0,0,0,0,0,A        ; 例：揭示全图
```

`Disabled=0` + `Easy/Medium/Hard=1/1/1` → 三种难度都跑。

### 6.2 延迟执行

```
[Events]
0A000002=1,13,0,60                 ; 60 秒后
```

（事件 51 是「随机延迟」，官方图里 `51,0,500` 这种写法。）

### 6.3 玩家进入某区域

```
[CellTags]
<rx + 1000*ry（和 [Waypoints] 同一个数）>=0A000001

[Tags]
0A000001=0,Area Trigger,0A000002

[Triggers]
0A000002=Americans,<none>,Area,0,1,1,1,0
[Events]
0A000002=1,1,0,0                  ; 事件1 Entered by：p2=房主码（0=Americans）
[Actions]
0A000002=1,21,6,EVA_UnitLost,0,0,0,0,A
```

事件 24/25/26 是「进入区域 / 越过横线 / 越过竖线」，必须挂在**格子**上（CellTag）。

### 6.4 油田开局给玩家 N（多人，YR）

思路：油田先按 Neutral 放好，挂一次性标签，开局触发器把「挂标签的对象」改成玩家位。

```
[Structures]
0=Neutral,CAOILD,256,<rx>,<ry>,0,0A000001,0,0,1,0,0,None,None,None,0,0

[Tags]
0A000001=0,Oil for A,0A000002

[Triggers]
0A000002=Neutral,<none>,Oil for A,0,1,1,1,0

[Events]
0A000002=1,8,0,0                  ; 开局立即

[Actions]
0A000002=1,14,0,4475,0,0,0,0,A    ; 14 改所属，4475 = 玩家位 A
```

- 4475–4482 = 玩家位 A–H（FA2 的 House 下拉里就是 `4475 <Player @ A>` …）。
  这个编码来自 FA2 的 `ListHouses`，社区教程也用这个值。
- 想整族一起给（比如所有中立科技楼）用动作 36：`36,0,4475,...`，触发器房主 = `Neutral`。
- 单人/战役图不需要 4475：`[Structures]` 第 1 字段直接写房主名即可（官方图大量实例）。
- **待实测**：在遭遇战里玩家是自己选国家的，所以用国家名当房主并不可靠；
  4475 这条路是社区标准做法，发布前应在真实 YR 多人局里验证一次。

### 6.5 建筑被摧毁 → 提示 / 失败

```
[Tags]
0A000001=0,Lab Guard,0A000002
[Structures]
...=Neutral,CALAB,256,<rx>,<ry>,0,0A000001,...

[Triggers]
0A000002=Neutral,<none>,Lab Lost,0,1,1,1,0
[Events]
0A000002=1,7,0,0                  ; 7 被摧毁（挂标签的对象）
[Actions]
0A000002=1,11,4,MSG_LabLost,0,0,0,0,A    ; 显示 CSF 文本
```

### 6.6 胜负 / 结束

```
[Actions]
0A000002=1,1,0,1,0,0,0,0,A        ; 1 胜利者是房主码 1
0A000002=1,67,0,0,0,0,0,0,A       ; 67 宣告胜利
```

### 6.7 揭示地图 / 镜头

```
16,0,0,0,0,0,0,A                  ; 全图
17,0,<路径点>,0,0,0,0,<字母码>     ; 路径点周围
48,0,<路径点>,0,0,0,0,<字母码>     ; 镜头移过去
112,0,<路径点>,0,0,0,0,<字母码>    ; 镜头跳过去
```

---

## 7. 给生成器的实现建议

1. **先做 `[Structures]` 房主**，不要上来就写触发器。它没有事件/参数/ID 的坑。
2. 触发器只暴露「简单选项」：开局立即 / N 秒后 / 某区域进入 / 某建筑被毁 → 做几个固定模板，
   内部拼 INI，不要开放全部 146 个动作。
3. 写节的位置：在 `MapGenMapFile.cpp` 现有 `[Structures]`/`[Terrain]` 之后追加
   `[Tags]`、`[CellTags]`、`[Triggers]`、`[Events]`、`[Actions]`（顺序不敏感，但保持稳定便于对拍）。
4. **坐标**：写一个 `cell_key(rx, ry) = rx + 1000*ry`（`[Waypoints]`/`[Terrain]`/`[CellTags]`
   共用），`[Structures]` 则写 `..., rx, ry, ...`。注意 FA2 源码的 `x/y` 名字和这里相反，
   别照名字直译。
5. **ID**：`id = fnv1a(seed, "trigger", n) & 0xFFFFFFFF` 之类，确保同种子逐字节一致；
   写之前检查不与已有键冲突。
6. **难度**：默认 `Disabled=0, Easy=1, Medium=1, Hard=1`；想只在高难度跑就改 0/1。
7. **不要空写 section**：没有触发器就别输出 `[Triggers]` 等节（现在的图是干净的）。
8. **验收套件**（建议新增 `verify_triggers`，纯 Python oracle 即可）：
   - 解析自己写出的图：`[Tags]` 引用的触发器都存在、`[Events]/[Actions]` 的 count 与 token 数一致；
   - `[CellTags]` 的键按 §2.6 反解回格子，和写入的 (rx,ry) 对得上；
   - 动作 14/36 的房主码在合法集合（0–15 或 4475–4482）；
   - 动作 125 的建筑名在规则里存在；
   - 同一张图两次生成逐字节相同；
   - 用真实官方图当回归样本：把官方图的触发节读进来再写一遍，结构不丢。

---

## 8. 还没定论 / 需要实测的点

- `[Triggers]` 第 8 个字段（第 5 个 flag）语义：官方图恒 0，FA2 也没给复选框，先照 0 写。
- `[Tags]` 类型 `1`：官方图里见过（挂在建筑上），FA2 只暴露 0/2，生成器不用 1。
- 动作 99/125 这类「用路径点」的动作，引擎到底读第 8 个字母码还是某个数字参数：
  官方图两者都写且一致，生成器照抄即可；建议先用不依赖路径点的动作验证通路。
- 多人 4475–4482 在遭遇战中的实际归属：需要一局真实游戏确认（社区教程一致说可用）。
- 遭遇战里 `[Structures]` 房主名会不会被大厅选择的国家覆盖：需要实测，别假设。
- 事件「AND」语义：官方图的多事件组合支持这个结论，但还没用引擎源码逐行确认。
- 事件 13/51 的时间单位：官方图里 720/600/180/25/10 这类值更像「秒」，
  但 FA2 没有单位提示，第一次实测时务必确认（这决定「60 秒后」这类配方怎么写）。

---

## 9. 出处

- **FinalAlert 2 官方源码**（EA 2024 年公开）：
  `MissionEditor/data/FinalAlert2/FAData.ini` 的 `[EventsRA2]` / `[ActionsRA2]` / `[ParamTypes]`
  —— 本文第 3、4 节两张完整表的唯一来源。
- `MissionEditor/TriggerActionsDlg.cpp`、`TriggerEventsDlg.cpp`：
  `[Actions]` 每条固定 8 token、`[Events]` 每条 3 token、`TruncSpace` 截断、
  路径点字母编码（`GetWaypoint`）、`-N` 固定参数。
- `MissionEditor/MapData.cpp`：`AddStructure` 的 17 字段顺序、`[CellTags]` 的
  `x*1000+y` 打包（FA2 的 x/y 与 IsoMapPack 的 rx/ry 转置）、`AddCelltag`、`IsYRMap`。
- `MissionEditor/Triggers.cpp` / `TriggerOptionsDlg.cpp`：`[Triggers]` 8 字段、
  Disabled/Easy/Medium/Hard、`[Tags]` 类型 0/2。
- `MissionEditor/functions.cpp`：`ListHouses`（4475–4482 玩家位）、
  `ListBuildings`（0-based 类型序号）、`PosToXY`。
- **真实地图**：`MAPSMD03.MIX` 里的 YR 战役 `.mmx`（触发/标签/油田归属的实例），
  以及 CNCMaps 测试素材里的官方多人图。
- 社区教程：[Changing Neutral objects to a specific Owner](https://cncguild.net/item-211)
  （动作 14 + 玩家位）、[Build stuff in Final Alert and make it yours](https://www.moddb.com/games/cc-red-alert-2/tutorials/build-stuff-in-final-alert-and-make-it-yours-very-easy)
  （动作 36 + 开局事件 8）。
