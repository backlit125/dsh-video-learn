// lib/recognizer.js —— 视频链接识别与平台路由（纯本地，不出网）
const URL_RE = /https?:\/\/[^\s<>"'）)】]+/gi

const PLATFORMS = [
  { id: 'bilibili', label: 'Bilibili', re: /(^|\.)bilibili\.com$/i, short: [/^b23\.tv$/i], bvid: /\/(BV[0-9A-Za-z]{10})/ },
  { id: 'youtube', label: 'YouTube', re: /(^|\.)(youtube\.com|youtu\.be)$/i, watch: [/(?:v=|youtu\.be\/)([0-9A-Za-z_-]{11})/] },
  { id: 'vimeo', label: 'Vimeo', re: /(^|\.)vimeo\.com$/i },
  { id: 'douyin', label: '抖音', re: /(^|\.)(douyin|iesdouyin)\.com$/i },
  { id: 'xiaohongshu', label: '小红书', re: /(^|\.)xiaohongshu\.com$/i },
  { id: 'acfun', label: 'Acfun', re: /(^|\.)acfun\.cn$/i },
]

export function extractUrls(text) {
  return String(text || '').match(URL_RE) || []
}

export function classify(rawUrl) {
  let u
  try { u = new URL(rawUrl) } catch { return { ok: false, reason: '链接格式无效' } }
  const host = u.hostname
  for (const p of PLATFORMS) {
    if (p.re.test(host)) return route(p, u)
    if (p.short?.some((re) => re.test(host))) return { ok: true, platform: p.id, label: p.label, needsResolve: true, url: rawUrl }
  }
  return { ok: true, platform: 'generic', label: host, url: rawUrl }
}

function route(p, u) {
  if (p.id === 'bilibili') {
    const m = u.pathname.match(p.bvid)
    return { ok: true, platform: 'bilibili', label: p.label, bvid: m?.[1] ?? null, url: u.href, supported: true }
  }
  if (p.id === 'youtube') {
    const vid = p.watch.map((re) => (u.href.match(re) ?? [])[1]).find(Boolean) ?? null
    return { ok: true, platform: 'youtube', label: p.label, videoId: vid, url: u.href, supported: true }
  }
  return { ok: true, platform: p.id, label: p.label, url: u.href, supported: p.id !== 'generic' }
}

export const SUPPORT_GUIDE = {
  bilibili: '走 bili-whale 工具链（debrief：元信息+字幕+弹幕热区+热评+抽帧）。',
  youtube: 'v1 仅抓网页元信息（标题/简介/时长）；需要完整内容请用户补字幕/文字稿，或后续接 yt-dlp。',
  generic: '通用抓取：只拿网页标题与简介；正文缺失必须标注置信度。',
}

export const MISSING_PROMPT =
  '无法完整获取视频内容。请补充以下任一材料：视频文件 / 字幕文件(SRT·VTT) / 文字稿 / 关键截图 / 章节列表 / 人工摘要。'
