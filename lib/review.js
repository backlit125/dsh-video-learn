// lib/review.js —— 每日复习：筛选 → 生成复习卷 → 更新状态 → 落复习记录
const today = () => new Date().toLocaleDateString('sv-SE')

/**
 * 挑选复习对象：
 *  - high priority 未复习过的
 *  - 低置信度（<0.7）久未复习（>3 天）
 *  - 即将遗忘：reviewCount>0 且距上次复习 > [1,3,7,14,30][min(count,4)] 天
 *  - skillCandidate 待确认
 */
export function pickReviewSet(store, { max = 8, topicHint = [] } = {}) {
  const now = Date.now()
  const docs = store.all().filter((d) => d.status === 'active' || d.status === 'stale')
  const scored = docs.map((d) => {
    const last = new Date(d.lastReviewed || d.createdAt).getTime()
    const daysIdle = (now - last) / 86400000
    const dueGap = [1, 3, 7, 14, 30][Math.min(4, d.reviewCount || 0)]
    let s = 0
    if (d.priority === 'high' && !d.reviewCount) s += 3
    if (d.confidence < 0.7 && daysIdle > 3) s += 2.5
    if ((d.reviewCount || 0) > 0 && daysIdle >= dueGap) s += 2
    if (d.skillCandidate && !d.skillConfirmed) s += 1.5
    if (d.flagged) s += 1.5
    if (d.status === 'stale') s += 1
    if (topicHint.some((t) => (d.tags || []).includes(t) || d.topic === t)) s += 2
    s += (d.mastery ?? 0.5) < 0.4 ? 1 : 0
    return { d, s, daysIdle }
  }).filter((x) => x.s > 0).sort((a, b) => b.s - a.s).slice(0, max)
  return scored.map(({ d, s, daysIdle }) => ({
    id: d.id, title: d.title, summary: d.summary, topic: d.topic, tags: d.tags,
    confidence: d.confidence, mastery: d.mastery, reviewCount: d.reviewCount,
    daysIdle: Math.round(daysIdle * 10) / 10, reason: reasons(d, s), _score: s,
  }))
}

function reasons(d, s) {
  const r = []
  if (d.priority === 'high' && !d.reviewCount) r.push('高优先级未复习')
  if (d.confidence < 0.7) r.push('低置信度待核查')
  if (d.flagged) r.push('调用失败被标记')
  if (d.skillCandidate && !d.skillConfirmed) r.push('技能候选待确认')
  if ((d.reviewCount || 0) > 0) r.push(`距上次复习${Math.round((Date.now() - new Date(d.lastReviewed || d.createdAt).getTime()) / 86400000)}天`)
  if (!r.length) r.push(`综合分${s.toFixed(1)}`)
  return r.join('、')
}

/** 复习完成后回写：调用 store.review + 生成当日复习卷（本地 md + 由 index 决定要不要推 Notion） */
export function renderReviewSheet(set, at = today()) {
  const lines = [`# 每日视频知识复习 · ${at}`, '', `入选 ${set.length} 条：`, '']
  for (const [i, e] of set.entries()) {
    lines.push(`## ${i + 1}. ${e.title}`,
      `- 主题：${e.topic}　标签：${(e.tags || []).join(', ')}`,
      `- 入选原因：${e.reason}`,
      `- 当前：置信度 ${e.confidence}　掌握 ${e.mastery}　已复习 ${e.reviewCount} 次`,
      `- 回顾：${e.summary}`,
      `- 自评：看懂了吗？（0=忘了 0.3=模糊 0.6=记得 1=能讲给别人）`, '')
  }
  return lines.join('\n')
}
