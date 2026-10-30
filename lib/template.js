// lib/template.js —— 学习日志：22 字段模板 + Markdown 渲染 + 拆知识条目
export const LOG_TEMPLATE = {
  learnedAt: '学习日期',
  title: '视频标题',
  url: '视频链接',
  platform: '来源平台',
  duration: '视频时长',
  author: '视频作者或发布者',
  topic: '视频主题分类',
  summary: '内容摘要',
  corePoints: '核心观点列表',
  knowledge: '关键知识点列表',
  terms: '重要术语解释',
  cases: '视频中的案例或示例',
  steps: '可操作步骤或流程',
  data: '数据、结论或证据',
  quotes: '金句或关键原文摘录',
  doubts: '存疑点或待验证内容',
  relations: '与已有知识的关联',
  skills: '可迁移技能',
  actions: '后续行动建议',
  tags: '标签',
  priority: '复习优先级 high|normal|low',
  confidence: '知识置信度 0-1',
  timestamps: '引用时间戳或章节位置',
}

const LIST_KEYS = ['corePoints', 'knowledge', 'cases', 'steps', 'data', 'quotes', 'doubts', 'relations', 'skills', 'actions', 'tags', 'timestamps']

const sec = (title, rows) => `\n## ${title}\n${rows.filter(Boolean).join('\n') || '_（无）_'}\n`
const li = (arr) => (Array.isArray(arr) ? arr : [arr]).filter((x) => x !== undefined && x !== null && x !== '').map((x) => `- ${x}`)

export function renderMarkdown(log) {
  const kv = (k) => (Array.isArray(log[k]) ? li(log[k]).join('\n') : log[k] ? `- ${log[k]}` : '')
  const head = sec('元信息', [
    `- 学习日期：${log.learnedAt || ''}`,
    `- 视频标题：${log.title || ''}`,
    `- 视频链接：${log.url || ''}`,
    `- 来源平台：${log.platform || ''}`,
    `- 时长：${log.duration || ''}`,
    `- 作者/发布者：${log.author || ''}`,
    `- 主题分类：${log.topic || ''}`,
    `- 复习优先级：${log.priority || 'normal'}　知识置信度：${log.confidence ?? ''}`,
  ])
  const body = sec('内容摘要', kv('summary') ? [kv('summary')] : [])
  const parts = [
    `# [视频学习] ${log.title || '未命名'} | ${log.learnedAt || ''}`,
    head, body,
    sec('核心观点', li(log.corePoints)),
    sec('关键知识点', li(log.knowledge)),
    sec('重要术语解释', Array.isArray(log.terms) ? li(log.terms) : Object.entries(log.terms || {}).map(([k, v]) => `- **${k}**：${v}`)),
    sec('案例或示例', li(log.cases)),
    sec('可操作步骤或流程', li(log.steps)),
    sec('数据、结论或证据', li(log.data)),
    sec('金句或关键原文摘录', li(log.quotes)),
    sec('存疑点或待验证内容', li(log.doubts)),
    sec('与已有知识的关联', li(log.relations)),
    sec('可迁移技能', li(log.skills)),
    sec('后续行动建议', li(log.actions)),
    sec('标签', li(log.tags)),
    sec('引用时间戳/章节位置', li(log.timestamps)),
    log.reviews?.length ? sec('复习记录', log.reviews.map((r) => `- ${r.at}　${r.note || ''}`)) : '',
    log.missing?.length ? sec('缺失部分（已如实标注）', li(log.missing)) : '',
  ]
  return parts.filter(Boolean).join('')
}

/** 从学习日志拆出可长期检索的知识条目（知识层 + 技能层）。 */
export function splitKnowledge(log) {
  const src = { videoId: log.videoId, url: log.url, platform: log.platform, title: log.title }
  const out = []
  const conf = Number.isFinite(Number(log.confidence)) ? Number(log.confidence) : 0.6
  const push = (kind, title, body, timestamps) => out.push({
    kind, title: String(title).slice(0, 120), summary: String(body || '').slice(0, 200), body: String(body || ''),
    topic: log.topic || '未分类', tags: [...(log.tags || []), kind], source: { ...src, kind },
    timestamps: timestamps || log.timestamps || [],
    confidence: kind === 'doubt' ? Math.min(conf, 0.4) : conf,
    scope: 'video-learn',
  })
  for (const k of log.knowledge || []) push('knowledge', k, k)
  for (const k of log.corePoints || []) push('point', k, k)
  for (const [k, v] of Object.entries(log.terms && !Array.isArray(log.terms) ? log.terms : {})) push('term', k, `${k}：${v}`)
  for (const k of Array.isArray(log.terms) ? log.terms : []) push('term', k, k)
  for (const k of log.steps || []) push('procedure', k, Array.isArray(k) ? k.join(' → ') : k)
  for (const k of log.skills || []) push('skill', k, k)
  for (const k of log.doubts || []) push('doubt', k, k)
  return out
}

export const validateLog = (log) => {
  const miss = ['title', 'url', 'topic', 'summary'].filter((k) => !log[k])
  const warn = LIST_KEYS.filter((k) => Array.isArray(log[k]) && log[k].length === 0)
  return { ok: miss.length === 0, missingRequired: miss, emptySections: warn }
}
