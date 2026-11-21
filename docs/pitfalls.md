# 对接 CCS 时踩过的坑

按踩坑顺序记录，重实现时逐条避开。

## 1. 事件流必须是长连接，且每个事件要带 `data`

`event-feed` 是 NDJSON，每行一个事件：

```json
{"type": "teams", "id": "123", "data": {...}}
```

**少了 `data` 包装 = 被视为删除该对象**，榜单会一直空白。

服务端必须是 `HTTP/1.1`（HTTP/1.0 响应结束即断连），客户端会反复刷「Waiting to reconnect」。

## 2. nginx 反代必须关缓冲

```nginx
proxy_buffering off;
proxy_cache off;
proxy_read_timeout 24h;
proxy_set_header Connection '';
```

开了缓冲，SSE 被攒着不发，大屏表现成连不上。

## 3. `penalty_time` 单位是分钟

CCS 规范里 `penalty_time` 是**分钟**。ICPC Tools 的 `Info.addImpl` 是：

```java
parseInt(value) * 60000     // 转成毫秒
```

发成秒会让罚时放大 60 倍。

## 4. RelativeTime 必须恰好 3 位小数

```
0:13:07.000   ✅
0:13:07.00    ❌ ParseException: Invalid contest time string
```

## 5. 时长不能乱填

牛客的 `endTime` 有时是报名截止（3 天后），算出 73 小时。
ICPC Tools 的时间轴会因此错乱，表现为**题目格子疯狂闪烁**。

必须夹到合理范围（6 小时内）。

## 6. 换图片要版本化文件名

ICPC Tools 按 URL 缓存下载的图片（`%TEMP%\org.icpc.tools.cache.http…/`），
同名换图不生效。用 `logoA2.png` 这种带版本号的名字，或者启动前清缓存。

## 7. 中文字体

不设 `ICPC_FONT` 时中文全是方块 □□□。
Windows 上设 `DengXian` 可解。

## 8. 显示器参数是「编号 + 模式字母」

```
1     全屏（独占）
1w    窗口
1a/1b 左上 / 右上四分之一
1x    ⚠️ 会切显示器模式，1280×720 会被切成 3840×2160，
      之后布局算出负数宽高 → 画面堆叠越界
```

## 9. `start-status` 不是普通开关

`sites` 想显示成三色圆点，`id` **不要**加 `site_` 前缀；
加了前缀会走「按组织 logo 大小表示状态」的另一套逻辑（10% / 65% / 100%）。

## 10. 判题状态码要实测

牛客的状态码（实测）：

```
0  评测中/排队    → PENDING
4  答案错误       → WA
5  答案通过       → AC
6  超时           → TLE
7  内存超限       → MLE
12 编译错误       → CE
15 运行错误       → RTE
```

`8`/`13` 按 PE/OLE 猜测，未验证；出现未知码要能自动去详情页抓真实结论。

## 11. 判题队列四个必踩的坑

复刻 `JudgePresentation` 时，这几处一旦写错，症状都是「画面一直蓝色闪烁、等不到判题结果」：

**① `updateTargets()` 必须每帧调用**

```java
// JudgePresentation.incrementTimeMs:141-146
updateRecords(dt);
updateTargets(false);   ← 少这行，行号永远停在初始值，行不动、也不会滑出
```

只更新记录不重算目标行，记录会永远卡在进场起点（第 14 行）。

**② `Animator.setTarget()` 必须做速度连续性修正**

`Animator.java:118-135` 那段「已经在移动就把零时刻前推/倒推」不能省。
省掉之后每次重设目标都把当前位置当静止起点重新加速，视觉上是「一顿一顿」。

另外 `acc` 必须带符号（`if (xTarget < xInitial) acc = -acceleration`），
否则上移和下移的曲线方向会反。

**③ 判题状态看 `judgement_type_id`，不是「有 judgement 记录」**

CCS 里 `judgements` 记录先建、`judgement_type_id` 后填（判题机出结果时才写）。
拿「存在 judgement 对象」当已判，会在排队阶段就误报 FAILED（或反过来永远 pending）。
正确做法：过滤 `judgement_type_id != null`，再按 `judgement-types` 的
`solved` / `penalty` 定状态。

而且 `judgement-types` 可能比 `judgements` 晚到，状态映射要能在类型表更新后重建，
不能只在启动时算一次。

**④ 首屏播种别按 `contest_time` 排序**

同一场里时间戳相同的提交只可能来自同一个队（模拟数据尤其明显），
按时间取「最近 N 条」会得到清一色的同一支队、同一道题。
要取 `Map` 的插入顺序（= 事件到达顺序 = Java 里 `submissions` 列表的顺序）。

## 12. 标题会被表头切掉一半

`TitledPresentation.paint` 的顺序是 **先 `paintHeader()`（表头图）再画标题**。

1080p 下 `headerHeight = H/50 = 21px`，而 `titleFont = size0*2.2 ≈ 50px`，
标题的 ascent 有 45px，远超表头带高度。

如果先画标题再画表头黑条，标题下半截会被盖住 —— 看起来像「字只剩上半截」。
照源码顺序就没问题：表头图铺在 `titleHeight` 处，标题随后画在顶部并压在上面。
