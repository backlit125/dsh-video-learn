/**
 * dsh-video-learn —— 视频学习闭环插件
 *
 * 闭环：链接识别 → 素材获取（B站复用 bili-whale 六路 / 其它平台抓元信息）
 *   → 22 字段结构化学习日志 → 强记忆库（条目/关联/权重） → Notion·OneNote·本地
 *   → 每日复习（筛选/回写/技能候选） → 任务调用（检索+来源标注）
 *   → 技能沉淀（版本管理） → 自我提升（反馈调权/合并相似/主题综述）
 *
 * 原则：脚本只备素材与记账，**判断由模型完成**（不虚构视频内容）；
 *       拿不到的内容必须标注缺失与置信度；本地永远落盘，云端尽力而为。
 */
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

import { createStore } from './store.js'
import { makeSync } from './sync.js'
import { extractUrls, classify, SUPPORT_GUIDE, MISSING_PROMPT } from './recognizer.js'
import { fetchBilibili, fetchWeb } from './fetcher.js'
import { renderMarkdown, splitKnowledge, validateLog, LOG_TEMPLATE } from './template.js'
import { pickReviewSet, renderReviewSheet } from './review.js'

export const name = 'dsh-video-learn'
export const inject = ['tools', 'workingDirectory']

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DEFAULTS = {
  enabled: true,
  storage: 'notion',            // local | notion(内置写入器) | command(外部脚本)
  project: '视频学习',
  // 云端凭证：留空则回落 环境变量 NOTION_TOKEN / ~/.dsh/notion.json
  notionToken: '',
  notionParentPageId: '',
  // storage=command 时用，例："node C:/path/to/wrapper.mjs"（正文经 --bodyfile 传入）
  syncCommand: '',
  syncTimeoutMs: 600_000,
  reviewDailyHours: 24,         // 复习最小间隔
  recallLimit: 5,
  biliTimeoutMs: 1_800_000,
  withFrames: true,             // B站深读是否抽帧（贵的一步）
}

const today = () => new Date().toLocaleDateString('sv-SE')
const str = (v) => (typeof v === 'string' ? v.trim() : '')
const num = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d }

export function apply(ctx, rawConfig) {
  const cfg = { ...DEFAULTS, ...(rawConfig && typeof rawConfig === 'object' ? rawConfig : {}) }
  if (!cfg.enabled) return

  const DSH_HOME = process.env.DSH_HOME || path.join(process.env.USERPROFILE || process.env.HOME || '.', '.dsh')
  const DIR = path.join(DSH_HOME, 'video-learn')
  const store = createStore(DIR)
  const sync = makeSync(DIR, cfg)
  const log = (level, msg) => { try { const l = ctx.logger ?? ctx.root?.logger; if (l?.[level]) l[level]('[video-learn] ' + msg) } catch {} }

  // ── 状态（复习节律 / 最近任务） ──
  const STATE = path.join(DIR, 'state.json')
  const readState = () => { try { return JSON.parse(fs.readFileSync(STATE, 'utf8')) } catch { return {} } }
  const writeState = (o) => { try { fs.writeFileSync(STATE, JSON.stringify(o, null, 2)) } catch {} }

  // ══════════════ 工具 1：识别链接（不抓取，先回"能不能学/缺什么"） ══════════════
  ctx.tools.register({
    name: 'video_detect',
    description: '识别一段文本里的视频链接并判断平台与可学性（B站可深学；YouTube/通用只拿元信息；不可达/不支持会说明原因）。用户发来链接先跑这个。',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: { text: { type: 'string', description: '用户消息原文或链接本身' } },
      required: ['text'],
    },
    output: { schema: { type: 'object', properties: { ok: { type: 'boolean' }, links: { type: 'array' }, advice: { type: 'string' } }, required: ['ok'] } },
    async execute(args) {
      const urls = [...new Set(extractUrls(args.text))]
      if (!urls.length) return { ok: true, links: [], advice: '没有识别到视频链接。' }
      const links = urls.map((u) => { const c = classify(u); return { ...c, guide: c.ok ? (SUPPORT_GUIDE[c.platform] ?? SUPPORT_GUIDE.generic) : null, ask: c.ok ? null : MISSING_PROMPT } })
      return { ok: true, links, advice: links.some((l) => !l.ok) ? '有链接不可学：' + MISSING_PROMPT : (links.some((l) => l.platform === 'bilibili') ? 'B站链接 → 用 video_learn 深学。' : '非B站链接 → 只能拿元信息，建议让用户补字幕/文字稿，或说明置信度受限。') }
    },
  })

  // ══════════════ 工具 2：抓取素材（备料，判断留给模型） ══════════════
  ctx.tools.register({
    name: 'video_fetch',
    description: '抓取视频素材：B站调 bili-whale 的 debrief（标题/简介/官方字幕/弹幕热区/热评/九宫格抽帧路径）；其它平台抓网页元信息。返回给模型阅读的材料路径清单，不做内容判断。',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        url: { type: 'string', description: '视频链接' },
        with_frames: { type: 'boolean', description: 'B站是否抽帧看画面（默认按配置）' },
      },
      required: ['url'],
    },
    output: { schema: { type: 'object', properties: { ok: { type: 'boolean' }, platform: { type: 'string' }, title: { type: 'string' }, materials: { type: 'object' }, missing: { type: 'array' }, note: { type: 'string' } }, required: ['ok'] } },
    timeoutMs: cfg.biliTimeoutMs + 120_000,
    async execute(args, exec) {
      const url = str(args.url)
      const c = classify(url)
      if (!c.ok) return { ok: false, missing: ['链接无效'], note: c.reason + '　' + MISSING_PROMPT }
      const signal = exec?.signal
      try {
        if (c.platform === 'bilibili' && c.bvid) {
          const wf = typeof args.with_frames === 'boolean' ? args.with_frames : cfg.withFrames
          const r = await fetchBilibili(c.bvid, { withFrames: wf, timeoutMs: cfg.biliTimeoutMs })
          const missing = []
          if (!r.subtitle) missing.push('官方字幕（可用抽帧/画面识别替代，或请用户提供文字稿）')
          if (wf && !r.sheet) missing.push('画面九宫格（可能无直链或抽帧失败）')
          return { ok: true, platform: 'bilibili', bvid: r.bvid, title: r.title, videoId: 'vl_bili_' + r.bvid,
            materials: { debriefText: r.raw.slice(0, 60_000), subtitleFile: r.subtitle?.file, sheetImage: r.sheet, subsImage: r.subs, danmakuPeaks: /弹幕热区/.test(r.raw), hotComments: /热评/.test(r.raw) },
            confidenceCap: missing.length ? 0.6 : 0.9,
            missing, note: '素材已备齐部分。下一步：模型用 read_image 看 sheetImage/subsImage、读 subtitleFile，合成 22 字段学习日志交给 video_learn_log。' }
        }
        const r = await fetchWeb(url, { timeoutMs: 25_000 })
        return { ok: true, platform: 'web', title: r.title, videoId: 'vl_' + r.url.slice(0, 40),
          materials: { description: r.description, author: r.author, duration: r.duration, thumbnail: r.thumbnail, publishedAt: r.publishedAt },
          confidenceCap: 0.4, missing: ['字幕', '正文台词', '画面内容'],
          note: r.note + '　' + MISSING_PROMPT }
      } catch (e) {
        const msg = String(e?.message || e)
        const reason = /412|429|风控/.test(msg) ? '触发平台风控，请稍后重试' : /超时|timeout/i.test(msg) ? '视频过长或处理超时（可用 --no-frames 或分段）' : /403|需要登录|会员|HTTP 4/.test(msg) ? '需要登录/会员/地区权限，无法访问' : msg.slice(0, 200)
        return { ok: false, platform: c.platform, missing: [reason], note: reason + '　' + MISSING_PROMPT }
      }
    },
  })

  // ══════════════ 工具 3：提交学习日志（结构化落库 + 同步 + 拆知识条目） ══════════════
  ctx.tools.register({
    name: 'video_learn_log',
    description: '提交模型完成分层理解后的结构化学习日志（必填 title/url/topic/summary；其余 18 字段按 LOG_TEMPLATE 尽量填全）。插件会：存本地主档 → 同步 Notion/OneNote → 拆成带 ID 的知识条目入库建索引。缺字段会返回提示而不是硬拦。',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        log: { type: 'object', description: '学习日志对象。字段：learnedAt,title,url,platform,duration,author,topic,summary,corePoints[],knowledge[],terms{},cases[],steps[],data[],quotes[],doubts[],relations[],skills[],actions[],tags[],priority(high|normal|low),confidence(0-1),timestamps[],missing[]' },
        videoId: { type: 'string', description: 'video_fetch 返回的 videoId（有则沿用）' },
        sync_backend: { type: 'string', enum: ['local', 'notion', 'command'], description: '本次同步后端，默认按插件配置 storage' },
      },
      required: ['log'],
    },
    output: { schema: { type: 'object', properties: { ok: { type: 'boolean' }, videoId: { type: 'string' }, knowledgeIds: { type: 'array' }, local: { type: 'string' }, cloud: { type: 'object' }, warnings: { type: 'array' } }, required: ['ok'] } },
    async execute(args) {
      const log0 = { ...(args.log || {}) }
      log0.learnedAt = log0.learnedAt || today()
      const v = validateLog(log0)
      if (!v.ok) return { ok: false, warnings: ['缺少必填字段：' + v.missingRequired.join(', ') + '。补齐后再提交（不许虚构缺失内容）。'] }
      const videoId = str(args.videoId) || store.kid(log0.title, log0.url)
      log0.videoId = videoId
      // 学习日志主档 + 渲染 + 同步
      store.putLog(log0)
      const md = renderMarkdown(log0)
      const fileName = `[视频学习] ${log0.title} | ${log0.learnedAt}`
      const pub = await sync.publish({ fileName, title: log0.title, project: cfg.project, markdown: md, backend: args.sync_backend })
      // 拆知识条目入库（强记忆）
      const items = splitKnowledge(log0)
      const ids = items.map((it) => store.putKnowledge(it).id)
      // 条目之间建关联（同属一条视频）
      for (let i = 0; i < Math.min(ids.length, 8); i++) {
        const e = store.all().find((x) => x.id === ids[i])
        if (e) { e.relations.push({ targetId: videoId, type: 'derived_from', at: new Date().toISOString() }); }
      }
      store.event('learn-done', log0.title, { videoId, items: ids.length })
      return { ok: true, videoId, knowledgeIds: ids, local: pub.local, cloud: pub.cloud,
        warnings: [...(v.emptySections.length ? ['以下部分为空，如素材确实没有可忽略：' + v.emptySections.join(', ')] : []), ...(pub.cloudWarn ? [pub.cloudWarn] : []), ...(log0.missing?.length ? [`已记录缺失：${log0.missing.join('；')}`] : [])] }
    },
  })

  // ══════════════ 工具 4：手动录入（无字幕/转写失败时的替代通道） ══════════════
  ctx.tools.register({
    name: 'video_ingest_text',
    description: '当视频无法抓取/无字幕/转写失败时，接收用户提供的字幕、文字稿或人工摘要，落为低置信度学习记录（明确标注来源为用户补充）。',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        url: { type: 'string', description: '原视频链接（可空）' },
        title: { type: 'string', description: '标题' },
        kind: { type: 'string', enum: ['subtitle', 'transcript', 'manual_summary', 'chapters', 'screenshots'], description: '材料类型' },
        text: { type: 'string', description: '材料正文（字幕/文字稿/摘要/章节列表）' },
      },
      required: ['title', 'kind', 'text'],
    },
    output: { schema: { type: 'object', properties: { ok: { type: 'boolean' }, videoId: { type: 'string' }, savedTo: { type: 'string' }, next: { type: 'string' } }, required: ['ok'] } },
    async execute(args) {
      const id = store.kid(args.title, args.url || args.kind)
      const file = path.join(DIR, 'inbox', `${id}-${args.kind}.txt`)
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, `# 来源：用户补充（${args.kind}）　视频：${args.url || '未提供'}\n\n${args.text}`, 'utf8')
      store.event('ingest', args.title, { kind: args.kind, file })
      return { ok: true, videoId: id, savedTo: file,
        next: '现在请基于这份材料做分层理解（主题→章节/观点/案例/数据/结论→概念/方法/流程/术语→技能），再调 video_learn_log 提交；confidence 上限 0.5 并写明缺失部分。' }
    },
  })

  // ══════════════ 工具 5：任务调用（检索知识 + 技能） ══════════════
  ctx.tools.register({
    name: 'video_recall',
    description: '用户提出任务/问题时检索已学视频知识与技能。返回条目须在使用时标注"来自已学视频知识"并给出来源链接；检索为空必须如实说没有学过，不得虚构。命中后应回写反馈（video_feedback）。',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        query: { type: 'string', description: '任务目标/问题/关键词（可含约束与隐含需求）' },
        limit: { type: 'number', description: '返回条数，默认 5' },
        topic: { type: 'string', description: '限定主题分类（可选）' },
      },
      required: ['query'],
    },
    output: { schema: { type: 'object', properties: { ok: { type: 'boolean' }, hits: { type: 'array' }, skills: { type: 'array' }, empty: { type: 'boolean' }, hint: { type: 'string' } }, required: ['ok'] } },
    async execute(args) {
      const hits = store.search(args.query, num(args.limit, 1, 10, cfg.recallLimit))
        .map((h) => ({ id: h.entry.id, kind: h.entry.tags?.[0], title: h.entry.title, summary: h.entry.summary, topic: h.entry.topic,
          confidence: h.entry.confidence, mastery: h.entry.mastery, score: h.score,
          source: { url: h.entry.source?.url, platform: h.entry.source?.platform, videoTitle: h.entry.source?.title },
          relations: (h.entry.relations || []).slice(0, 5) }))
      const topicFiltered = args.topic ? hits.filter((h) => h.topic === args.topic) : hits
      const kw = String(args.query || '').toLowerCase()
      const skills = store.skills().filter((s) => (s.name + ' ' + (s.scenario || '') + ' ' + (s.steps || []).join(' ')).toLowerCase().includes(kw) || kw && (s.tags || []).some((t) => kw.includes(String(t).toLowerCase()))).slice(0, 3)
      const empty = topicFiltered.length === 0 && skills.length === 0
      return { ok: true, hits: topicFiltered, skills, empty,
        hint: empty ? '知识库没有相关内容 → 如实告知用户"没学过这个视频/主题"，不得编造。'
          : '使用规则：① 标注每条依据的来源视频与链接（模型自身推理另说）；② 置信度 <0.6 的条目要加"待验证"；③ 命中知识相互冲突时列出不同观点并给判断建议；④ 用完调 video_feedback 回写成败。' }
    },
  })

  // ══════════════ 工具 6：调用反馈（自我提升原料） ══════════════
  ctx.tools.register({
    name: 'video_feedback',
    description: '回写一次知识调用的结果：成功（采纳/用户认可）或失败（用户纠正/知识错误）。插件据此调整置信度与优先级，失败会标记待核查。',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        id: { type: 'string', description: '知识条目 ID' },
        ok: { type: 'boolean', description: '本次调用是否有效' },
        note: { type: 'string', description: '简短原因（如"用户指出 X 已改版"）' },
      },
      required: ['id', 'ok'],
    },
    output: { schema: { type: 'object', properties: { ok: { type: 'boolean' }, entry: { type: 'object' } }, required: ['ok'] } },
    async execute(args) {
      const e = store.feedback(args.id, !!args.ok, str(args.note))
      return e ? { ok: true, entry: { id: e.id, confidence: e.confidence, useOk: e.useOk, useFail: e.useFail, flagged: e.flagged } } : { ok: false }
    },
  })

  // ══════════════ 工具 7：每日复习 ══════════════
  ctx.tools.register({
    name: 'video_review',
    description: '执行一次复习（每日一次即可，插件按 reviewDailyHours 节律提示）。返回复习卷：筛选高优先级/低置信度/将遗忘/技能候选条目，附回顾要点；模型带用户过完后用 video_review_done 回写。',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: { force: { type: 'boolean', description: '忽略节律立刻复习' }, max: { type: 'number', description: '最多几条（默认 8）' }, topic_hint: { type: 'array', items: { type: 'string' }, description: '近期常用主题，加权' } },
    },
    output: { schema: { type: 'object', properties: { ok: { type: 'boolean' }, due: { type: 'boolean' }, sheet: { type: 'string' }, count: { type: 'number' }, stats: { type: 'object' } }, required: ['ok'] } },
    async execute(args) {
      const st = readState()
      const hours = Math.max(1, Number(cfg.reviewDailyHours) || 24)
      const due = args.force || !st.lastReviewAt || Date.now() - new Date(st.lastReviewAt).getTime() >= hours * 3600_000
      if (!due) return { ok: true, due: false, count: 0, stats: store.stats(), hint: `距上次复习不足 ${hours} 小时（force=true 可立刻复习）` }
      const set = pickReviewSet(store, { max: num(args.max, 1, 30, 8), topicHint: args.topic_hint || [] })
      const sheet = renderReviewSheet(set)
      writeState({ ...st, pendingReviewAt: new Date().toISOString(), pendingCount: set.length })
      store.event('review-open', `入选 ${set.length} 条`, { count: set.length })
      return { ok: true, due: true, count: set.length, sheet, items: set.map(({ _score, ...x }) => x), stats: store.stats(),
        hint: set.length ? '带用户过完每条后调 video_review_done 逐条回写掌握度（0/0.3/0.6/1）；复习过的知识会加权，稳定的升技能候选。' : '知识库为空或全部无需复习。' }
    },
  })

  ctx.tools.register({
    name: 'video_review_done',
    description: '回写复习结果：更新复习次数、最近复习时间、掌握程度、检索权重；可新增知识关联；达到阈值的自动标为技能候选。并把复习摘要追加到笔记。',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        results: { type: 'array', description: '每条复习结果 [{id, mastery(0-1), note, newRelation:{targetId,type}}]' },
        summary: { type: 'string', description: '本次复习摘要（写进复习记录）' },
      },
      required: ['results'],
    },
    output: { schema: { type: 'object', properties: { ok: { type: 'boolean' }, updated: { type: 'number' }, candidates: { type: 'array' }, reviewNote: { type: 'string' } }, required: ['ok'] } },
    async execute(args) {
      const results = Array.isArray(args.results) ? args.results : []
      let updated = 0
      const candidates = []
      const lines = [`# 复习记录 · ${today()}`, '', `> ${str(args.summary) || '（无摘要）'}`, '']
      for (const r of results) {
        const e = store.review(str(r.id), { mastery: Number.isFinite(Number(r.mastery)) ? Number(r.mastery) : undefined, note: str(r.note), newRelation: r.newRelation })
        if (!e) continue
        updated++
        lines.push(`- **${e.title}**　掌握 ${e.mastery}　第 ${e.reviewCount} 次复习　置信度 ${e.confidence}${e.skillCandidate ? '　⭐技能候选' : ''}`)
        if (e.skillCandidate && !e.skillConfirmed) candidates.push({ id: e.id, title: e.title, topic: e.topic, note: '已满足"≥3 次复习且掌握≥0.7、置信≥0.8"，建议用 video_skill_add 沉淀为技能' })
      }
      writeState({ ...readState(), lastReviewAt: new Date().toISOString(), lastReviewCount: updated })
      let reviewNote = ''
      if (updated && args.summary) {
        const md = lines.join('\n')
        const srcLog = store.allLogs().find((l) => results.some((r) => (store.all().find((x) => x.id === r.id)?.source?.videoId) === l.id))
        reviewNote = sync.writeLocal(`复习-${today()}`, md).replace(/\.md$/, '.md')
        try { await sync.appendReview({ fileName: `复习-${today()}`, title: srcLog?.title || '视频知识', reviewMarkdown: md }) } catch {}
      }
      return { ok: true, updated, candidates, reviewNote, stats: store.stats() }
    },
  })

  // ══════════════ 工具 8：技能沉淀 ══════════════
  ctx.tools.register({
    name: 'video_skill_add',
    description: '把知识沉淀为可复用技能（回答模板/分析框架/写作结构/检查清单/流程图/提示词片段/决策规则/任务拆解/评估标准）。同名技能再提交 = 版本 +1。',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        name: { type: 'string', description: '技能名称' },
        scenario: { type: 'string', description: '适用场景' },
        input: { type: 'string', description: '输入要求' },
        output: { type: 'string', description: '输出形式' },
        steps: { type: 'array', items: { type: 'string' }, description: '操作步骤' },
        example: { type: 'string', description: '示例' },
        notes: { type: 'string', description: '注意事项' },
        sourceUrl: { type: 'string', description: '来源视频链接' },
        fromKnowledge: { type: 'array', items: { type: 'string' }, description: '来源知识条目 ID' },
      },
      required: ['name', 'scenario', 'steps'],
    },
    output: { schema: { type: 'object', properties: { ok: { type: 'boolean' }, skill: { type: 'object' } }, required: ['ok'] } },
    async execute(args) {
      const missing = ['scenario', 'input', 'output', 'steps', 'example', 'notes'].filter((k) => !args[k] || (Array.isArray(args[k]) && !args[k].length))
      if (!args.steps?.length) return { ok: false, hint: '技能必须含操作步骤，缺失字段：' + missing.join(', ') }
      const s = store.addSkill({ name: args.name, scenario: args.scenario, input: args.input || '', output: args.output || '', steps: args.steps, example: args.example || '', notes: args.notes || '', source: args.sourceUrl || '', fromKnowledge: args.fromKnowledge || [] })
      for (const id of args.fromKnowledge || []) { const e = store.all().find((x) => x.id === id); if (e) { e.skillConfirmed = true; } }
      return { ok: true, skill: { name: s.name, version: s.version }, hint: '任务匹配时优先调用该技能，并在回答中说明来源与用法；新视频学到更优做法时重新提交即可升版本。' }
    },
  })

  // ══════════════ 工具 9：知识库管理（状态/合并/综述/删除） ══════════════
  ctx.tools.register({
    name: 'video_kb',
    description: '知识库管理与自我提升：status 统计；merge 合并相似知识；summary 生成主题综述/能力卡片；list 列学习日志；delete 删除某条知识或整个视频记录（用户要求删除时用）。',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['status', 'merge', 'summary', 'list', 'delete'], description: '操作' },
        topic: { type: 'string', description: 'summary 用：限定主题' },
        threshold: { type: 'number', description: 'merge 用：相似度阈值 0-1，默认 0.55' },
        id: { type: 'string', description: 'delete 用：知识条目 ID（k_xxx）或视频 ID（vl_xxx）' },
      },
      required: ['action'],
    },
    output: { schema: { type: 'object', properties: { ok: { type: 'boolean' }, data: { type: 'object' } }, required: ['ok'] } },
    async execute(args) {
      if (args.action === 'status') return { ok: true, data: { ...store.stats(), sync: sync.channels, storage: cfg.storage, state: readState() } }
      if (args.action === 'merge') return { ok: true, data: { merged: store.mergeSimilar(num(args.threshold, 0.2, 0.95, 0.55)), index: store.rebuildIndex() } }
      if (args.action === 'summary') { const s = store.summarizeTopic(str(args.topic)); return { ok: true, data: s } }
      if (args.action === 'list') return { ok: true, data: { logs: store.allLogs().map((l) => ({ id: l.id, title: l.title, learnedAt: l.learnedAt, topic: l.topic, priority: l.priority, confidence: l.confidence })) } }
      if (args.action === 'delete') {
        const id = str(args.id)
        if (!id) return { ok: false, hint: '需要 id' }
        if (id.startsWith('k_')) return { ok: store.remove(id), data: { removed: id } }
        // 视频记录：连带其派生知识条目
        const docs = store.all().filter((d) => d.source?.videoId === id)
        docs.forEach((d) => store.remove(d.id))
        store.remove(id)
        return { ok: true, data: { removedVideo: id, removedKnowledge: docs.map((d) => d.id) } }
      }
      return { ok: false }
    },
  })

  // ══════════════ 系统提示：让"自动识别 + 闭环"真正生效的那块拼图 ══════════════
  // DSH 没有给插件暴露"用户消息钩子"的稳定公开接口；最可靠的做法是让模型在对话里
  // 主动执行识别与闭环（与 bili-whale 用 prompt 驱动同一思路）。
  try {
    const sp = ctx.get?.('systemPrompt')
    if (sp && typeof sp.section === 'function') {
      sp.section({
        name: 'video-learn:closed-loop',
        order: 9200,
        text: [
          '【视频学习闭环】当用户消息中出现视频链接（B站/YouTube/短链/分享链接等）时，主动执行：',
          '1) `video_detect` 判平台与可学性；不可达/需登录/不支持 → 明确说明原因并按提示请用户补材料（视频文件/字幕/文字稿/截图/章节/摘要），补来用 `video_ingest_text` 录入。',
          '2) 可学 → `video_fetch` 备料（B站含官方字幕与九宫格抽帧；抽帧得到的 SHEET/SUBS 图片必须用 read_image 看，不读图=没看画面）。',
          '3) 你来做分层理解（主题→章节/观点/案例/数据/结论→概念/方法/流程/术语→可复用技能），把 22 字段日志交给 `video_learn_log` 提交；' +
          '拿不到的部分写进 missing 并压低 confidence，**绝不虚构视频里没有的内容**；涉及医疗/法律/金融/安全要在回答里加风险提示。',
          '4) 用户之后提任务/问题时先 `video_recall` 检索已学知识与技能；命中就采用，并在回答里**区分「来自已学视频知识（附来源链接）」与「模型自身推理」**；' +
          '低置信度条目要标「待验证」；知识互相冲突时列出不同观点并给判断建议；检索为空要如实说没学过。用完调 `video_feedback` 回写成败。',
          '5) 每天提醒或执行一次 `video_review`（复习卷→带用户过→`video_review_done` 回写掌握度）；达到阈值的条目用 `video_skill_add` 沉淀为技能并版本管理。',
          '6) 用户要求忘记/删除时用 `video_kb delete`；`video_kb merge` 定期合并重复知识。',
        ].join('\n'),
      })
      log('info', '已注册闭环提示段（识别→学习→复习→调用→沉淀）')
    }
  } catch (e) { log('warn', 'systemPrompt 段落注册失败（工具仍可用，但不会自动触发）：' + e.message) }

  try { console.log(`[video-learn] 已注册 10 个工具；数据目录 ${DIR}；同步=${cfg.storage}（Notion凭证=${sync.channels.notion ? '有' : '无'}，外部脚本=${sync.channels.command ? '有' : '无'}）`) } catch {}
}

export default { name, inject, apply }
