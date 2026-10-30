// lib/store.js —— 强记忆库：知识条目 / 关联 / 权重 / 检索 / 技能
// 纯本地 JSON，无数据库依赖。检索 = 关键词 TF-IDF + 标签加权 + 状态加权。
// 中文检索用 bigram（中文无空格，整句切出来是一个永不命中的巨型 token）。
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

const nowIso = () => new Date().toISOString()
const today = () => new Date().toLocaleDateString('sv-SE')

const PUNCT = /[\s,、;；。.!！?？:：/|()（）\[\]【】"'`~～—…\-]+/

/** 码位判断（纯 ASCII 写法，避开 CJK 字面量在管道里被吞的问题）。 */
function isCjk(ch) {
  const c = ch.codePointAt(0)
  return (c >= 0x3400 && c <= 0x4dbf) || (c >= 0x3040 && c <= 0x30ff)
    || (c >= 0x4e00 && c <= 0x9fff) || (c >= 0xac00 && c <= 0xd7af)
}

/** 分词：拉丁词整块保留；CJK 连续段切二元组（单字太噪、整句永不命中）。 */
export function tokenize(s) {
  const out = []
  for (const w of String(s || '').toLowerCase().split(PUNCT).filter(Boolean)) {
    // 按 CJK / 非 CJK 交替切段
    const segs = []
    let cur = '', curCjk = null
    for (const ch of w) {
      const k = isCjk(ch)
      if (curCjk === null || k === curCjk) { cur += ch; curCjk = k; continue }
      segs.push([cur, curCjk]); cur = ch; curCjk = k
    }
    if (cur) segs.push([cur, curCjk])
    for (const [seg, cjk] of segs) {
      if (!cjk) { if (seg.length > 1) out.push(seg); continue }
      if (seg.length === 1) { out.push(seg); continue }
      for (let i = 0; i + 2 <= seg.length; i++) out.push(seg.slice(i, i + 2))
    }
  }
  return out
}

const jaccard = (a, b) => { const inter = [...a].filter((x) => b.has(x)).length; const uni = new Set([...a, ...b]).size; return uni ? inter / uni : 0 }
const num = (v, d) => (Number.isFinite(Number(v)) ? Math.max(0, Math.min(1, Number(v))) : d)

export function createStore(dir) {
  const K = path.join(dir, 'knowledge')
  const L = path.join(dir, 'logs')
  fs.mkdirSync(K, { recursive: true })
  fs.mkdirSync(L, { recursive: true })
  const SKILLS = path.join(dir, 'skills.json')
  const INDEX = path.join(dir, 'index.json')
  const EVENTS = path.join(dir, 'events.jsonl')

  const slug = (s) => crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 8)
  const kid = (title, src) => 'k_' + today().replace(/-/g, '') + '_' + slug(title + '|' + src)

  const readJson = (p, d) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return d } }
  const writeJson = (p, v) => { const t = p + '.' + process.pid + '.tmp'; fs.writeFileSync(t, JSON.stringify(v, null, 2)); fs.renameSync(t, p) }
  const all = () => fs.readdirSync(K).filter((f) => f.endsWith('.json')).map((f) => readJson(path.join(K, f), null)).filter(Boolean)

  function event(kind, note, extra = {}) {
    try { fs.appendFileSync(EVENTS, JSON.stringify({ at: nowIso(), kind, note, ...extra }) + '\n') } catch {}
  }

  const esc = (q) => q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

  function search(query, limit = 5) {
    const qs = [...new Set(tokenize(query))].filter((t) => t.length > 1)
    if (!qs.length) return []
    const docs = all()
    if (!docs.length) return []
    const df = {}
    for (const q of qs) df[q] = docs.filter((d) => haystack(d).includes(q)).length
    const hits = []
    for (const d of docs) {
      const h = haystack(d)
      let s = 0
      for (const q of qs) {
        if (!h.includes(q)) continue
        const idf = Math.log(1 + docs.length / Math.max(1, df[q]))
        const tf = (h.match(new RegExp(esc(q), 'g')) || []).length
        s += (1 + Math.log(tf)) * idf
      }
      if (s === 0) continue
      // 标签/主题命中加倍
      for (const q of qs) if ((d.tags || []).some((t) => String(t).toLowerCase().includes(q))) s *= 1.4
      // 状态加权：置信度、掌握度、复习衰减、调用成败
      s *= 0.5 + d.confidence * 0.5
      s *= 1 + Math.min(1, (d.mastery || 0)) * 0.3
      s *= 1 + Math.min(3, Math.log2(1 + (d.reviewCount || 0))) * 0.12
      s *= 1 + Math.min(3, Math.log2(1 + (d.useOk || 0))) * 0.2
      const daysIdle = (Date.now() - new Date(d.lastReviewed || d.createdAt).getTime()) / 86400000
      if (d.confidence < 0.7 && daysIdle > 3) s *= 1.25          // 低置信度久未复习 → 提升召回（待核查）
      if (d.flagged || d.status === 'retired') s *= 0.2
      hits.push({ entry: d, score: Number(s.toFixed(3)) })
    }
    hits.sort((a, b) => b.score - a.score)
    return hits.slice(0, Math.max(1, Math.min(50, limit || 5)))
  }

  function haystack(d) {
    return [d.title, d.summary, d.body, d.topic, ...(d.tags || []), ...(d.aliases || [])].join(' ').toLowerCase()
  }

  // ---- 写入知识条目 ----
  function putKnowledge({ title, summary, body, topic, tags, source, timestamps, confidence, relations, scope }) {
    const id = kid(title, source?.videoId || source?.url || '')
    const file = path.join(K, id + '.json')
    const prev = readJson(file, null)
    const e = prev ?? {
      id, title, summary: summary || '', body: body || '', topic: topic || '未分类',
      tags: tags || [], aliases: [], source: source || {}, timestamps: timestamps || [],
      confidence: num(confidence, 0.6),
      weight: 1, mastery: 0, reviewCount: 0, lastReviewed: null, useOk: 0, useFail: 0,
      relations: [], status: 'active', flagged: false, createdAt: nowIso(), updatedAt: nowIso(),
      scope: scope || 'general', version: 1,
    }
    if (prev) { // 已存在 → 合并（不覆盖复习统计）
      e.summary = summary || e.summary; e.body = body || e.body
      e.tags = [...new Set([...(e.tags || []), ...(tags || [])])]
      e.confidence = Math.max(e.confidence, num(confidence, e.confidence))
      e.version += 1
    }
    for (const r of relations || []) linkIn(e, r)
    e.updatedAt = nowIso()
    writeJson(file, e)
    event('knowledge-put', e.title, { id })
    return e
  }

  const linkIn = (e, r) => {
    const key = `${r.targetId}:${r.type}`
    if (!e.relations.some((x) => `${x.targetId}:${x.type}` === key)) e.relations.push({ ...r, at: nowIso() })
  }

  // ---- 学习日志（一视频一条）----
  function putLog(log) {
    const id = log.videoId || 'v_' + slug(log.url)
    const file = path.join(L, id + '.json')
    const prev = readJson(file, null)
    const merged = { ...prev, ...log, id, updatedAt: nowIso(), createdAt: prev?.createdAt ?? nowIso(), reviews: [...(prev?.reviews || []), ...(log.reviews || [])] }
    writeJson(file, merged)
    event('log-put', merged.title, { id })
    return merged
  }
  const getLog = (id) => readJson(path.join(L, id + '.json'), null)
  const allLogs = () => fs.readdirSync(L).filter((f) => f.endsWith('.json')).map((f) => readJson(path.join(L, f), null)).filter(Boolean)

  // ---- 复习 ----
  function review(id, { note, mastery, newRelation } = {}) {
    const file = path.join(K, id + '.json')
    const e = readJson(file, null)
    if (!e) return null
    e.reviewCount = (e.reviewCount || 0) + 1
    e.lastReviewed = nowIso()
    if (Number.isFinite(Number(mastery))) e.mastery = Math.max(0, Math.min(1, Number(mastery)))
    else e.mastery = Math.min(1, (e.mastery || 0) + 0.1)
    if (note) e.reviews = [...(e.reviews || []), { at: e.lastReviewed, note }]
    if (newRelation) linkIn(e, newRelation)
    if (e.reviewCount >= 3 && e.mastery >= 0.7 && e.confidence >= 0.8) e.skillCandidate = true
    if (e.reviewCount === 0 && (Date.now() - new Date(e.createdAt).getTime()) / 86400000 > 30 && e.confidence < 0.6) e.status = 'stale'
    e.updatedAt = nowIso()
    writeJson(file, e)
    event('review', e.title, { id, mastery: e.mastery, count: e.reviewCount })
    return e
  }

  // ---- 调用反馈（自我提升的原料）----
  function feedback(id, ok, note) {
    const file = path.join(K, id + '.json')
    const e = readJson(file, null)
    if (!e) return null
    if (ok) { e.useOk = (e.useOk || 0) + 1; e.confidence = Math.min(1, e.confidence + 0.05) }
    else { e.useFail = (e.useFail || 0) + 1; e.confidence = Math.max(0, e.confidence - 0.15); e.flagged = true }
    if (note) e.notes = [...(e.notes || []), { at: nowIso(), note }]
    e.updatedAt = nowIso()
    writeJson(file, e)
    event('feedback', e.title, { id, ok })
    return e
  }

  // ---- 技能 ----
  const skills = () => readJson(SKILLS, [])
  function addSkill(s) {
    const list = skills()
    const i = list.findIndex((x) => x.name === s.name)
    const rec = { name: s.name, scenario: s.scenario || '', input: s.input || '', output: s.output || '',
      steps: s.steps || [], example: s.example || '', notes: s.notes || '', source: s.source || '',
      version: i >= 0 ? (list[i].version || 1) + 1 : 1, useCount: i >= 0 ? list[i].useCount || 0 : 0,
      createdAt: i >= 0 ? list[i].createdAt : nowIso(), updatedAt: nowIso(), fromKnowledge: s.fromKnowledge || [] }
    if (i >= 0) list[i] = rec; else list.push(rec)
    writeJson(SKILLS, list); event('skill', rec.name, { version: rec.version })
    return rec
  }
  const useSkill = (name) => { const l = skills(); const i = l.findIndex((x) => x.name === name); if (i < 0) return null; l[i].useCount++; l[i].lastUsed = nowIso(); writeJson(SKILLS, l); return l[i] }

  // ---- 合并相似知识（自我提升）----
  function mergeSimilar(threshold = 0.55) {
    const docs = all()
    const done = []
    for (let i = 0; i < docs.length; i++) {
      for (let j = i + 1; j < docs.length; j++) {
        const a = docs[i], b = docs[j]
        if (a.status === 'retired' || b.status === 'retired') continue
        const sim = jaccard(new Set(tokenize(a.title + ' ' + a.summary)), new Set(tokenize(b.title + ' ' + b.summary)))
        if (sim >= threshold) {
          const keep = (a.reviewCount || 0) >= (b.reviewCount || 0) ? a : b
          const drop = keep === a ? b : a
          keep.tags = [...new Set([...(keep.tags || []), ...(drop.tags || [])])]
          keep.body = [keep.body, '---\n（合并自：' + drop.title + '）\n' + drop.body].filter(Boolean).join('\n\n')
          keep.relations.push({ targetId: drop.id, type: 'merged_from', at: nowIso() })
          keep.updatedAt = nowIso()
          drop.status = 'retired'; drop.mergedInto = keep.id; drop.updatedAt = nowIso()
          writeJson(path.join(K, keep.id + '.json'), keep)
          writeJson(path.join(K, drop.id + '.json'), drop)
          done.push({ kept: keep.id, retired: drop.id, sim: Number(sim.toFixed(2)) })
        }
      }
    }
    if (done.length) event('merge', `合并 ${done.length} 对`, { count: done.length })
    return done
  }

  // ---- 主题综述 ----
  function summarizeTopic(topic) {
    const docs = all().filter((d) => d.status === 'active' && (!topic || d.topic === topic))
    return { topic: topic || '全部', count: docs.length, items: docs.map((d) => ({ id: d.id, title: d.title, summary: d.summary, mastery: d.mastery, confidence: d.confidence, tags: d.tags })) }
  }

  function rebuildIndex() {
    const docs = all()
    const idx = { builtAt: nowIso(), total: docs.length, byTopic: {}, byTag: {}, byStatus: {} }
    for (const d of docs) {
      idx.byTopic[d.topic] = (idx.byTopic[d.topic] || 0) + 1
      for (const t of d.tags || []) idx.byTag[t] = (idx.byTag[t] || 0) + 1
      idx.byStatus[d.status] = (idx.byStatus[d.status] || 0) + 1
    }
    writeJson(INDEX, idx)
    return idx
  }

  const remove = (id) => { const f = path.join(K, id + '.json'); if (!fs.existsSync(f)) return false; fs.rmSync(f); event('delete', id, { id }); return true }

  return { dir: K, all, putKnowledge, putLog, getLog, allLogs, search, review, feedback, skills, addSkill, useSkill,
    mergeSimilar, summarizeTopic, rebuildIndex, remove, event, kid, tokenize,
    stats() { const d = all(); return { knowledge: d.length, active: d.filter((x) => x.status === 'active').length, stale: d.filter((x) => x.status === 'stale').length, flagged: d.filter((x) => x.flagged).length, candidates: d.filter((x) => x.skillCandidate).length, logs: allLogs().length, skills: skills().length } } }
}
