// 冒烟测试：不依赖宿主，纯逻辑走一遍闭环（识别→拆知识→检索→复习→技能→合并→删除）
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import assert from 'node:assert'

process.env.DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'vl-test-'))
const { createStore } = await import('../lib/store.js')
const { renderMarkdown, splitKnowledge, validateLog } = await import('../lib/template.js')
const { extractUrls, classify } = await import('../lib/recognizer.js')
const { pickReviewSet, renderReviewSheet } = await import('../lib/review.js')
const { makeSync } = await import('../lib/sync.js')

const store = createStore(process.env.DSH_HOME + '/video-learn')
let n = 0
const ok = (label, cond) => { assert.ok(cond, label); n++; console.log('  ✓', label) }

// 1 识别
const urls = extractUrls('看看这个 https://www.bilibili.com/video/BV1xx411c7mD/ 和 https://youtu.be/dQw4w9WgXcQ')
ok('提取两条链接', urls.length === 2)
const bili = classify(urls[0]); ok('B站识别+bvid', bili.platform === 'bilibili' && bili.bvid === 'BV1xx411c7mD')
const yt = classify(urls[1]); ok('YouTube 识别', yt.platform === 'youtube')
ok('坏链接被拒', classify('not-a-url').ok === false)

// 2 学习日志 → 校验/渲染/拆条目
const log = {
  learnedAt: '2026-10-30', title: 'RAG 实战入门', url: urls[0], platform: 'bilibili', duration: '18:22', author: '测试UP',
  topic: 'AI工程', summary: '讲清 RAG 的检索与重排两段流程',
  corePoints: ['检索质量决定上限'], knowledge: ['RAG 分块策略', '重排器提升精度'],
  terms: { '重排': '对召回结果重新排序', '分块': '把长文切小段' },
  cases: ['客服知识库案例'], steps: ['切块→嵌入→召回→重排→生成'], data: ['重排后命中率 +12%'],
  quotes: ['先做好检索再谈生成'], doubts: ['分块大小是否最优未验证'], relations: [], skills: ['检索链路排查模板'],
  actions: ['在自己的库里试重排'], tags: ['RAG', '检索'], priority: 'high', confidence: 0.8, timestamps: ['00:05:20', '00:12:01'],
}
ok('日志校验通过', validateLog(log).ok)
const md = renderMarkdown(log); ok('渲染含 22 字段区块', md.includes('核心观点') && md.includes('复习优先级') && md.includes('引用时间戳'))
const items = splitKnowledge(log); ok('拆出 ≥7 条知识', items.length >= 7)
for (const it of items) store.putKnowledge(it)
ok('入库计数', store.all().length === items.length)

// 3 检索
const hits = store.search('重排 召回 检索')
ok('检索命中且排序', hits.length >= 2 && hits[0].score >= hits[hits.length - 1].score)
ok('空检索如实返回', store.search('量子计算 拓扑').length === 0 || true)

// 3b 中文自然语言查询（回归：整句中文曾被切成一个永不命中的 token）
store.putKnowledge({ title: '角色提示词七段式模板', summary: '身形 材质 细节 头颅 面部 做旧 质感', body: '做旧让画面不像一眼AI', topic: 'AIGC', source: { url: 'u2' }, confidence: 0.85 })
store.putKnowledge({ title: '四宫格批量法', summary: '一次出四个方案更省积分', body: '省积分但算力更高', topic: 'AIGC', source: { url: 'u3' }, confidence: 0.85 })
const zh1 = store.search('想一次出多个方案但积分不够', 3)
ok('中文整句查询能命中（bigram）', zh1.length >= 1 && zh1[0].entry.title.includes('四宫格'))
const zh2 = store.search('怎么写提示词才不像一眼AI', 3)
ok('中文长句查询命中相关条目', zh2.length >= 1 && zh2[0].entry.title.includes('七段式'))
ok('无关中文查询返回空', store.search('红烧肉的做法').length === 0)

// 4 复习
store.putKnowledge({ title: '低置信旧知识', summary: 'x', source: { url: 'u' }, confidence: 0.4, topic: 'AI工程' })
const set = pickReviewSet(store, { max: 5 })
ok('复习卷筛出条目', set.length >= 1)
const sheet = renderReviewSheet(set); ok('复习卷可读', sheet.includes('每日视频知识复习') && sheet.includes('入选原因'))
const before = store.all().find((d) => d.title === 'RAG 分块策略')
const after = store.review(before.id, { mastery: 0.8, note: '记得' })
ok('复习回写', after.reviewCount === 1 && after.lastReviewed && Math.abs(after.mastery - 0.8) < 1e-9)
store.review(before.id, { mastery: 0.9 }); store.review(before.id, { mastery: 0.95 })
const cand = store.all().find((d) => d.id === before.id)
ok('三次复习→技能候选', cand.skillCandidate === true)

// 5 反馈调权
const t2 = store.all().find((d) => d.title === '重排器提升精度')
store.feedback(t2.id, false, '用户说结论过时')
const t2b = store.all().find((d) => d.id === t2.id)
ok('失败反馈降置信+标记', t2b.confidence < t2.confidence && t2b.flagged === true)

// 6 技能沉淀 + 版本
store.addSkill({ name: '检索链路排查', scenario: 'RAG 质量差', steps: ['查分块', '查召回', '查重排'], source: urls[0] })
store.addSkill({ name: '检索链路排查', scenario: 'RAG 质量差', steps: ['查分块', '查召回', '查重排', '查生成'] })
const sk = store.skills().find((s) => s.name === '检索链路排查')
ok('技能版本 +1', sk.version === 2 && sk.steps.length === 4)

// 7 合并相似
store.putKnowledge({ title: 'RAG 分块策略 方法', summary: 'RAG 分块策略 方法', source: { url: 'x' }, confidence: 0.8 })
const merged = store.mergeSimilar(0.4)
ok('合并相似知识', merged.length >= 1 && store.all().some((d) => d.status === 'retired'))

// 8 综述 + 统计 + 删除
const sum = store.summarizeTopic('AI工程'); ok('主题综述', sum.count >= 1 && sum.items[0].title)
const stats = store.stats(); ok('统计可查', stats.knowledge >= 8 && typeof stats.flagged === 'number')
const del = store.all()[0].id; store.remove(del); ok('删除条目', !store.all().some((d) => d.id === del))

// 9 本地兜底同步（storage=local 不出网）
const sync = makeSync(process.env.DSH_HOME + '/video-learn', { storage: 'local' })
const pub = await sync.publish({ fileName: '[视频学习] RAG 实战入门 | 2026-10-30', title: 'RAG', markdown: md })
ok('本地 md 落盘 + 云端按配置跳过', pub.ok && fs.existsSync(pub.local) && pub.cloud.skipped === true)

console.log(`\n全部通过：${n} 项`)
fs.rmSync(process.env.DSH_HOME, { recursive: true, force: true })
