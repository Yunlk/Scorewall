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
