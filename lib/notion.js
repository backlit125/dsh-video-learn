// lib/notion.js —— 内置 Notion 写入器（不依赖任何外部脚本）
// 凭证来源优先级：config.notionToken/ParentPageId ← 环境变量 ← ~/.dsh/notion.json
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const HOME = process.env.USERPROFILE || process.env.HOME || os.homedir()
const CFG_FILE = path.join(process.env.DSH_HOME || path.join(HOME, '.dsh'), 'notion.json')
const VERSION = '2022-06-28'

function credentials(cfg = {}) {
  let file = {}
  try { file = JSON.parse(fs.readFileSync(CFG_FILE, 'utf8')) } catch {}
  const token = cfg.notionToken || process.env.NOTION_TOKEN || file.token || ''
  const parentPageId = cfg.notionParentPageId || process.env.NOTION_PARENT_PAGE_ID || file.parentPageId || ''
  return { token, parentPageId }
}

async function call(method, p, token, body) {
  for (let i = 0; i < 5; i++) {
    try {
      const res = await fetch('https://api.notion.com' + p, {
        method,
        headers: { Authorization: 'Bearer ' + token, 'Notion-Version': VERSION, 'Content-Type': 'application/json',
          ...(body ? { 'Content-Length': String(Buffer.byteLength(JSON.stringify(body))) } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      })
      const text = await res.text()
      if (res.ok) return { ok: true, json: JSON.parse(text) }
      // 4xx（除 429）是硬错误，重试无意义
      if (res.status >= 400 && res.status < 500 && res.status !== 429) return { ok: false, status: res.status, text }
    } catch { /* 网络抖动，继续重试 */ }
    await new Promise((s) => setTimeout(s, 700 + i * 600))
  }
  return { ok: false, status: 0, text: 'RETRY_EXHAUSTED' }
}

/** Markdown → Notion block 数组（标题/列表/代码/分隔线；够学习日志用）。 */
export function mdToBlocks(markdown) {
  const out = []
  const rt = (s) => String(s).split('`').map((seg, i) => i % 2 === 1
    ? { type: 'text', text: { content: seg.slice(0, 1900) }, annotations: { code: true } }
    : { type: 'text', text: { content: seg.slice(0, 1900) } }).filter((x) => x.text.content)
  let inCode = false, code = []
  for (const raw of String(markdown || '').split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '')
    if (/^```/.test(line.trim())) {
      inCode = !inCode
      if (!inCode && code.length) out.push({ object: 'block', type: 'code', code: { rich_text: rt(code.join('\n')), language: 'plain text' } })
      if (!inCode) code = []
      continue
    }
    if (inCode) { code.push(line); continue }
    if (!line.trim()) continue
    let m
    if ((m = /^#\s+(.*)$/.exec(line))) out.push({ object: 'block', type: 'heading_1', heading_1: { rich_text: rt(m[1]) } })
    else if ((m = /^#{2}\s+(.*)$/.exec(line))) out.push({ object: 'block', type: 'heading_2', heading_2: { rich_text: rt(m[1]) } })
    else if ((m = /^#{3,6}\s+(.*)$/.exec(line))) out.push({ object: 'block', type: 'heading_3', heading_3: { rich_text: rt(m[1]) } })
    else if ((m = /^\s*[-*]\s+(.*)$/.exec(line))) out.push({ object: 'block', type: 'bulleted_list_item', bulleted_list_item: { rich_text: rt(m[1]) } })
    else if ((m = /^\s*\d+\.\s+(.*)$/.exec(line))) out.push({ object: 'block', type: 'numbered_list_item', numbered_list_item: { rich_text: rt(m[1]) } })
    else if (/^(-{3,}|\*{3,})$/.test(line.trim())) out.push({ object: 'block', type: 'divider', divider: {} })
    else out.push({ object: 'block', type: 'paragraph', paragraph: { rich_text: rt(line) } })
  }
  return out
}

/** 建页 + 分块追加（Notion 单次 100 块上限，且首建只塞 90 块，余下 PATCH）。 */
export async function writePage({ title, markdown, cfg = {} }) {
  const { token, parentPageId } = credentials(cfg)
  if (!token || !parentPageId) return { ok: false, skipped: true, reason: '未配置 Notion 凭证（~/.dsh/notion.json 或 config.notionToken）→ 只写本地' }
  const blocks = mdToBlocks(markdown)
  if (!blocks.length) return { ok: false, reason: '日志为空，没有可写入的内容' }
  const first = blocks.slice(0, 90)
  const created = await call('POST', '/v1/pages', token, {
    parent: { page_id: parentPageId },
    properties: { title: { title: [{ text: { content: String(title).slice(0, 1900) } }] } },
    children: first,
  })
  if (!created.ok) return { ok: false, reason: `Notion 建页失败 ${created.status}：${String(created.text).slice(0, 200)}` }
  const pageId = created.json.id
  let sent = first.length
  for (let i = 90; i < blocks.length; i += 90) {
    const a = await call('PATCH', `/v1/blocks/${pageId}/children`, token, { children: blocks.slice(i, i + 90) })
    if (!a.ok) return { ok: true, partial: true, url: created.json.url, id: pageId, blocks: sent, total: blocks.length,
      reason: `追加第 ${i} 块起失败 ${a.status}，页面已建但内容不完整` }
    sent += Math.min(90, blocks.length - i)
    await new Promise((s) => setTimeout(s, 350))   // 尊重 ~3 req/s 限流
  }
  return { ok: true, url: created.json.url, id: pageId, blocks: sent, total: blocks.length, via: 'builtin' }
}

export const hasCredentials = (cfg = {}) => { const c = credentials(cfg); return Boolean(c.token && c.parentPageId) }
