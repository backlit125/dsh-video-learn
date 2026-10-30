# dsh-video-learn

> 给 DSH（DeepSeek Harness）装一套**视频学习闭环**：你发一个视频链接，它去把视频**看懂**，
> 拆成可长期检索的**知识条目**，写进 Notion（或本地），**每天复习**，
> 之后你提任务时**主动调用**这些知识并标注来源，高频知识再**沉淀成技能**。

零外部依赖：纯 `node:` 内置模块。B站深读复用 [dsh-bili-whale](https://github.com/Alterssss/dsh-bili-whale) 的工具链（可选）。

---

## 它解决什么问题

模型看完一条视频，转头就忘。你存了摘要也没用——摘要是一段死文本，检索不到、不会复习、越攒越乱。

这个插件把"看视频"变成**有状态的知识管理**：

| 环节 | 做法 |
|---|---|
| 看懂 | B站走官方字幕 + 弹幕热区 + 热评 + **ffmpeg 抽帧九宫格**（模型必须 `read_image` 读图，不读图=没看画面）；其它平台抓网页元信息 |
| 记住 | 22 字段学习日志 → **拆成带 ID 的知识条目**（不是存一段摘要）→ TF-IDF + bigram 检索 → 每条带置信度/掌握度/复习次数 |
| 复习 | 每天筛"高优先级 / 低置信度 / 快遗忘 / 技能候选"→ 出复习卷 → 回写掌握度 → 稳定的自动升为技能候选 |
| 调用 | 你提任务时先检索，命中就采用并**区分「来自已学视频知识（附来源）」与「模型自身推理」**；查不到必须如实说没学过 |
| 沉淀 | 重复有效的做法打包成技能，同名再提交 = 版本 +1 |

---

## 装

```bash
# 1) 装插件（本地目录 / npm / github 都行）
dsh plugin --profile desktop add "link:C:/path/to/dsh-video-learn"

# 2) 重启 DSH（bundle 层要重启才组装）

# 3) 跑测试确认逻辑正常
cd <插件目录> && node --test tests/smoke.mjs
```

**可选依赖**：只有"B站抽帧看画面"这一路需要 `ffmpeg` 与已安装的 `dsh-bili-whale`。
两者都没有时，插件照常工作 —— 退化为读元信息 + 让你手动补字幕/文字稿（`video_ingest_text`）。

---

## 配置

写在 profile 的 `cordis.patch.yml` 里（按 `id: dsh-video-learn` 覆盖），或改本包 `cordis.patch.yml`：

```yaml
- id: dsh-video-learn
  name: dsh-video-learn
  config:
    enabled: true
    storage: notion        # local | notion | command
    project: 视频学习
    notionToken: ""        # 留空则回落 环境变量 NOTION_TOKEN / ~/.dsh/notion.json
    notionParentPageId: "" # 同上
    syncCommand: ""        # storage=command 时用，例："node C:/tools/wrapper.mjs"
    syncTimeoutMs: 600000
    reviewDailyHours: 24   # 复习最小间隔
    recallLimit: 5
    withFrames: true       # B站深读是否抽帧（这一步贵，但它是"真看到画面"的唯一途径）
    biliTimeoutMs: 1800000
```

`~/.dsh/notion.json` 形如 `{ "token": "ntn_...", "parentPageId": "uuid" }`（Personal Access Token，权限给到目标页）。

**存储策略**：本地 Markdown **永远写**（`~/.dsh/video-learn/notes/`，是主档与兜底）；
云端失败只警告、不阻塞学习闭环。`storage: local` 时完全不碰网络。

---

## 工具（10 个）

| 工具 | 用途 |
|---|---|
| `video_detect` | 识别一段文本里的视频链接，判平台与可学性（不抓取，先看能不能学、缺什么） |
| `video_fetch` | 抓素材：B站返回字幕文件/九宫格/热评；其它平台返回网页元信息。**只备料，不判断** |
| `video_learn_log` | 提交模型做完分层理解的 22 字段日志 → 存本地 + 同步云端 + 拆知识条目入库 |
| `video_ingest_text` | 抓不到时的替代通道：用户给的字幕/文字稿/摘要/章节 → 落为**低置信度**记录 |
| `video_recall` | 任务来了先检索知识与技能；空则如实返回空 |
| `video_feedback` | 回写一次调用的成败 → 调置信度与优先级，失败自动标记待核查 |
| `video_review` | 出复习卷（按节律，`force` 可立刻） |
| `video_review_done` | 回写复习结果：复习次数/掌握度/权重/新关联，达标自动升技能候选 |
| `video_skill_add` | 沉淀技能（同名再提交 = 版本 +1） |
| `video_kb` | 知识库管理：status / merge（合并相似）/ summary（主题综述）/ list / delete |

插件还会注册一段 systemPrompt，让模型**主动**执行闭环：看到链接就 detect，可学就 fetch，
读完素材自己做分层理解再 learn_log，之后你提任务时先 recall。**不需要你每次提醒它。**

---

## 数据落在哪

```
~/.dsh/video-learn/
├── knowledge/k_YYYYMMDD_xxxx.json   每条知识一个文件（ID/正文/来源/时间戳/置信度/掌握度/关联/复习史）
├── logs/vl_bili_BVxxxx.json         学习日志主档（一视频一条）
├── notes/*.md                       渲染后的可读笔记（本地主档）
├── skills.json                      技能库（带版本与调用次数）
├── index.json                       主题/标签/状态统计
├── events.jsonl                     事件流（入库/复习/反馈/合并/删除，逐条留痕）
└── inbox/                           video_ingest_text 收的用户补充材料
```

全是普通 JSON/Markdown —— 人随时能打开看，没有数据库、没有守护进程。

---

## 设计原则（别指望它做不到的事）

1. **脚本只备料与记账，判断由模型做。** 插件不会替你总结视频 —— 它把字幕/弹幕/抽帧摆到你面前，由模型读、由模型写结论。这样"谁在胡说"是可追责的。
2. **拿不到就说拿不到。** 缺字幕、缺画面、需登录，一律写进 `missing` 并压低 `confidence`，绝不虚构视频里没有的内容。这是这套东西能长期用的前提。
3. **低置信度不是垃圾，是待核查。** 置信度 <0.7 且久未复习的条目会被**优先召回**（提醒你去核实），而不是被埋掉。
4. **本地永远是主档。** 云端挂了不影响你已有的一切。

### 已知边界

- 中文检索用 **bigram + TF-IDF**，不是真向量索引：近义词不召回（"汽车"查不到"轿车"），靠标签与主题加权缓解。要语义检索请接 embedding。
- 非 B站平台只拿到网页元信息（标题/简介/时长/封面），**没有内容**，置信度上限 0.4。
- 只读前台能拿到的东西，不登录、不绕权限、不碰 DRM。
- 长视频抽帧耗时长（按时长线性），已按 `120s + 1.5s/秒视频` 放宽超时；两小时片建议 `withFrames: false` 先读文字。

---

## 异常处理对照

| 情况 | 行为 |
|---|---|
| 链接无效 / 平台不支持 | `video_detect` 说明原因 + 给出可补材料清单 |
| 需登录 / 会员 / 地区权限 | `video_fetch` 返回 `ok:false` 与具体 HTTP 语义，不猜内容 |
| 无字幕且转写不可用 | 走抽帧看画面；仍不行 → `video_ingest_text` 收用户材料，置信度压到 0.5 以下 |
| 视频过长超时 | 提示用 `--no-frames` / 分段；超时按时长自动放宽 |
| Notion 未配置 / 同步失败 | 本地照常落盘，返回 `cloudWarn`，不抛错不中断 |
| 检索为空 | 如实返回空并提示"没学过，不得编造" |
| 知识互相矛盾 | 复习与反馈会调权；回答时要求列出不同观点并给判断建议 |

---

## 测试

```bash
node --test tests/smoke.mjs      # 24 项，纯逻辑 + 契约自检，不联网不碰你的笔记
```

覆盖：链接识别与平台路由、22 字段渲染、拆知识条目、**中文整句检索（bigram 回归用例）**、
复习筛选与回写、技能候选阈值、反馈调权、技能版本、合并相似、主题综述、删除、本地兜底同步。

---

## 许可

MIT
