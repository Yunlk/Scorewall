# CCS 载荷形状（以 ICPC Tools 的解析为准）

来源：`contestModel.jar` 里每个模型类的 `addImpl(name, value)` —— 它决定 ICPC Tools
认哪些字段、认什么类型。**字段名拼错或类型不对，对应值会被静默丢弃**（不报错，
只是画面上少东西）。

## 传输层

`GET <base>/api/contests/<id>/event-feed` 是 NDJSON 长连接，每行一个事件：

```json
{"type": "teams", "id": "123", "data": { ...对象... }}
```

规则：

- `type` 是对象类型（见下表），`id` 是主键
- **`data` 为 `null` 或不给 → 视为删除该对象**
- 事件按 `id` 去重/更新，不是按顺序追加
- 响应必须是 `HTTP/1.1` 且不结束，否则客户端反复重连

REST 快照（`/teams`、`/problems` …）返回的是**对象数组**，形状与事件里的 `data` 一致。

## 类型清单与字段

> 抽取时漏掉了 2 个字符的键（我的正则要求 ≥3 字符），所有对象都有 **`id`**（字符串），
> 下面不再重复。

### contest（比赛）

`type: "contest"`

```
id, name                     基本
start_time                    ISO8601，必须带 .000Z
duration                      H:MM:SS
scoreboard_thaw_time          解封时间
scoreboard_type
penalty_time                  ⚠️ 单位分钟
time_multiplier
countdown_pause_time
location, latitude, longitude
logo[], banner[]              图片引用：{href, width, height, tag?}
```

### team（队伍）

```
id, label, name, display_name
organization_id               指向 organization
group_ids[]                   字符串数组（unofficial / girl …）
icpc_id
hidden
location
photo{}, video{}, backup{}, keylog{}, tooldata{}, desktop{}, webcam{}, audio{}
                              tool data，都是 FileReference/对象
```

### problem（题目）

```
id, label(A/B/C), name, ordinal(整数)
color / rgb                   气球色，rgb 形如 "#FF7109"
uuid, package
statement[], attachments[]    文件引用数组
test_data_count, time_limit, memory_limit, output_limit, code_limit, max_score
```

### submission（提交）

```
id, team_id, problem_id, language_id
time                          ISO8601
contest_time                  ⚠️ 必须是 "0:13:07.000" —— 恰好 3 位小数
entry_point
person_id
files[]                       数组
reaction
```

### judgement（判题）

```
id, submission_id
judgement_type_id             AC / WA / TLE … 或自定义
score, current(布尔)
max_run_time
start_time / end_time                  ISO8601
start_contest_time / end_contest_time  RelativeTime（3 位小数）
```

### organization（组织/学校）

```
id, name, formal_name
icpc_id
country
logo{}, country_flag{}
url, hashtag, account
location, latitude, longitude
```

### group（分组）

```
id, name
type
hidden, variant
icpc_id
logo{}
```

### start_status（工位/开赛状态）

```
id
label                         显示名，如 "Judges"
status                        整数；0=未就绪(红) 1=待定(黄) 2=就绪(绿)
```

### judgement_type（判题类型）

```
id (AC/WA/TLE…), name
penalty(布尔)                 是否计罚时
solved(布尔)                  是否算通过
```

### language（语言）

```
id, name
extensions[]                  数组
entry_point_required(布尔), entry_point_name
compiler{}, runner{}
```

### clarification（答疑）

```
id
text
problem_id, from_team_id, to_team_id
reply_to_id
to_group_ids[]
draft(布尔)
```

### person / award

```
person:  id, team_id, team_ids[], role, first_name, last_name, email, sex, title, photo{}
award:   id, citation, team_ids[], display_mode, photos[]
```

## 解析时必须注意

1. **`penalty_time` 单位是分钟**（`Info.addImpl` 里 `parseInt(value) * 60000`）
2. **RelativeTime 恰好 3 位小数**，否则 `ParseException`
3. **图片引用是数组**，元素形如 `{"href": "/presentation/logoA2.png", "width": 1024, "height": 1024}`
4. 未知字段会被忽略，不会报错 —— 所以**字段名写错很难发现**，只能通过画面缺东西反推
5. 数值型字段（`ordinal`、`status`、`penalty`）传字符串会被 `parseInt` 兜住，
   但布尔型和数组不会
