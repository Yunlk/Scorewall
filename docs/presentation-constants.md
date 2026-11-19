# ICPC Tools 渲染常数（从源码扒出）

所有数值都来自上游 Java 源码，重实现时**照抄，不要凭感觉调**。

## 通用布局（`TitledPresentation` / `AbstractScoreboardPresentation.setup()`）

```
headerHeight = H / 50          # 表头（RANK NAME SOLVED TIME）
titleHeight  = H / 30          # 标题栏（时钟 + 标题）
teamsPerScreen = 12
rowHeight    = (H - headerHeight - titleHeight) / 12
base         = rowHeight * 36 * 0.95 / 96
```

字号：

```
rowFont      = base * 1.25     # 队名、名次、解题数
statusFont   = base * 0.7      # 格子里的「次数-分钟」
problemFont  = base * 0.5      # 空格子里的题目字母
titleFont    = (H * 0.021) * 2.2
clockFont    = (H * 0.021) * 1.25
headerFont   = min(H * 0.021, base * 0.85)
```

边距：

```
BORDER      = 8      # TitledPresentation.BORDER
CUBE_INSET  = 5      # 格子间距
ARC         = 7      # 格子圆角（ShadedRectangle.ARC）
```

## 题目格子

```
cubeHeight = rowHeight / 2.5 - 5
cubeWidth  = (rowHeight / 1.8 - 5) * 10
# 放不下就一直 -2，直到 (cubeWidth+5)*numProblems <= W - rowHeight*3 - 70
# 且 cubeWidth > 30
```

格子内文字：`次数` + hair space(U+200A) + `-` + hair space + `分钟`
（用普通空格会撑破格子被裁掉）

格子纵向位置：`rowHeight * 0.6 + CUBE_INSET/2 - 1`

## 颜色（`ICPCColors` + `ShadedRectangle`）

| 用途 | 值 |
| --- | --- |
| 通过 | `rgb(0, 230, 0)` |
| 失败 | `rgb(240, 0, 0)` |
| 判题中 | `rgb(66, 114, 245)`（文字用黑色） |
| 首杀（FTS） | 深绿 `rgb(0, 100, 0)` + 2px 绿色描边 |
| 空格子底 | `rgb(40, 40, 40)` |
| 空格子字母 | `rgba(196, 196, 196, 175)` |
| 奇数行底 | `rgb(60, 60, 60)` |
| 最近 30 秒 | 自上而下渐变，原色 → `darker(色, 0.55)` |

金牌/银牌/铜牌（颁奖用）：`rgb(205,127,50)` / `rgb(230,232,250)` / `rgb(166,125,61)`

## 标题栏

- 黑底，高度 `titleHeight`
- 标题居中，`titleFont`
- 左侧时钟在 `width/12` 处居中（已用时）
- 右侧时钟在 `width*11/12` 处居中（剩余时间）
- 表头带：高 `headerHeight`，白字，底部 1px 白线

## 时间格式（`AbstractICPCPresentation.getTime`）

```
h = (秒/3600) % 48
m = (|秒|/60) % 60
s = |秒| % 60
格式：h:mm:ss，小时不补零，分秒补零
未开始：< 0 且 h==0 时加负号  →  "-0:09:35"
```

**CCS 的 `RelativeTime` 必须恰好 3 位小数**（`0:13:07.000`），否则解析失败。

## 判题队列（`JudgePresentation`）

不是提交时间列表，而是**每条提交画一行队伍**：

- 左边：名次、队名、解题数、用时
- 中间：该队全部题目的格子
- 高亮：**这一发对应的那道题**的格子，填提交状态色，写「第几发 - 分钟」
- 其余已通过的题：深绿块（无文字）

## 题目汇总（`ProblemSummary` 色块版）

- 每块底色 = 题目气球色（`problem.getColorVal()`）
- 大字母：白描边 + 半透明深色填充
- 右上统计条：蓝=尝试数 / 绿=通过数 / 红=未通过 / 深绿=首杀分钟
- **数字是队伍数，不是提交数**（Java 的 `addResult` 每队每题调一次）
- 图例画在最后一行没被占满的空格里

## 七段倒计时（`StatusCountdownPresentation`）

- 数字用七段字形，不是普通字体
- 工位开关三态：`status = 0` 左圆红 / `1` 中圆黄 / `2` 右圆绿
- 就绪判定：`if (status == 2) numReadySites++`
- 工位数据来源：`organizations` + `start-status`（`{id, label, status}`）


## 格子文字颜色（`ShadedRectangle.createRoundRect`）

```java
if (paint == ICPCColors.PENDING_COLOR) g.setColor(Color.BLACK);  // 引用比较，实际进不去
else                                    g.setColor(Color.white);
```

`paint` 来自渐变数组 `PENDING[k]`（新对象），**`==` 永远不成立**，
所以除空格子（`BG_TEXT` 灰）外，**所有格子文字都是白色**。
黑色分支只在调用方直接传 `PENDING_COLOR` 常量时生效（如判题队列高亮块），
记分板格子不走那条。

## 格子文字内容

有提交就显示 `提交数-分钟`，**没有问号**；`Result.getNumSubmissions() = numPending + numJudged`，
所以 pending 也占一个提交号。状态只体现在背景色。
