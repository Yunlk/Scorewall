# icpc-bigscreen

ICPC Tools 那套赛场大屏视觉的**网页重实现**。不依赖 Java，换画面不掉线。

## 为什么

ICPC Tools 是 Java2D 应用，实际用下来坑很固定：

| 坑 | 现象 |
|---|---|
| 换画面要重启进程 | 黑屏 30~40 秒 |
| `--display` 是「编号+模式字母」 | 写成 `1x` 会把 1280×720 的屏切成 4K，布局算出负数宽高、画面堆叠越界 |
| 图片按 URL 缓存 | 换 logo 必须清 `%TEMP%\org.icpc.tools.cache.*`，否则永远旧图 |
| 中文字体 | 必须设 `ICPC_FONT=DengXian`，否则全方块 |
| 一个进程只能一个画面 | 左右分屏要开两个进程，时间线切换就失效 |

网页版把这些全部绕开：切视图是瞬时的，分屏是 CSS，字体随便挂。

## 目标

1. **视觉对齐 ICPC Tools** —— 尺寸/颜色全部从源码抄，不自己设计
2. **一个页面搞定左右屏** —— 左屏轮播、右屏固定判题队列
3. **对接任意 CCS 数据源** —— `http://…/api/contests/<id>` 或 NDJSON 事件流
4. **可离线** —— 静态文件即可部署

## 数据结构

输入是 CCS Contest API（我们的 `nowcoder-bridge` 已经实现）：

```
GET /api/contests/<id>                 比赛元信息（logo/banner/duration/penalty）
GET /api/contests/<id>/event-feed       NDJSON 事件流（team/problem/submission/judgement…）
GET /api/contests/<id>/teams|problems|submissions|judgements|organizations
```

## 画面清单（按 plan.md）

| 阶段 | 画面 | 编号 | 状态 |
| --- | --- | --- | --- |
| 赛前 | 带工位状态的倒计时 | 15 | 待做 |
| 赛中 | 题目柱状图（提交/通过） | 10 | 待做 |
| 赛中 | 题目汇总色块 | 29 | 已在旧版实现，待移植 |
| 赛中 | 总榜（12 行分页） | 58 | 已在旧版实现，待移植 |
| 赛中 | 一血 | 54 | 待做 |
| 赛末 30 分 | 圆形倒计时 | 16 | 待做 |
| 全程右屏 | 判题队列 | 56 | 已在旧版实现，待移植 |

「旧版」= `C:\Users\Yunlk\Desktop\重要\screen-service`，可作参考实现。

## 布局约定

```
左屏 = 轮播（按时间/阶段切换视图）
右屏 = 固定判题队列
```

一个页面两个 pane，`display: flex`；每个 pane 各自按自己的尺寸跑公式
（ICPC Tools 的布局全部相对高度 `H` 计算，所以 pane 宽度不同也不影响比例）。

## 参考

- `docs/presentation-constants.md` —— 从 ICPC Tools 源码扒出来的全部数值
- `docs/pitfalls.md` —— 对接 CCS 时踩过的坑
- 源码：https://github.com/icpctools/icpctools
- 上游文档：`C:\Users\Yunlk\Desktop\重要\nowcoder-bridge\docs\icpc-tools-presentation.md`

## 技术选型（待定）

优先考虑**零构建**：纯 HTML + CSS + 原生 JS。
理由：这套东西是"像素对齐"，不需要框架抽象，反而少一层干扰；部署就是静态文件。

如果后期要做复杂的状态管理再考虑引入。

## 许可

待定（若开源，参考上游 ICPC Tools 的许可条款）
