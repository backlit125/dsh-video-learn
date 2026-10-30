// lib/fetcher.js —— 视频素材获取：B站走 bili-whale 工具链；YouTube/通用走网页元信息
import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
const execFileAsync = promisify(execFile)

const HOME = process.env.USERPROFILE || process.env.HOME || process.env.HOMEPATH || '~'
const DSH_HOME = process.env.DSH_HOME || path.join(HOME, '.dsh')

/** 找一个"真 node"（Electron 主程序跑不了 .mjs 工具链 —— bili-whale 实测踩过）。 */
export function resolveNode() {
  const cands = [
    process.env.DSH_NODE,
    path.join(DSH_HOME, 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'node', 'bin', 'node.exe'),
    path.join(DSH_HOME, 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'node', 'node.exe'),
  ].filter(Boolean)
  for (const c of cands) { try { if (fs.existsSync(c)) return c } catch {} }
  try { if (process.platform !== 'win32' && !process.versions.electron) return process.execPath } catch {}
  return null
}

function biliWhaleRoot() {
  const cands = [
    path.join(DSH_HOME, 'profiles', 'desktop', 'node_modules', 'dsh-bili-whale'),
    path.join(DSH_HOME, 'plugins', 'dsh-bili-whale'),
  ]
  for (const c of cands) { try { if (fs.existsSync(path.join(c, 'tools', 'bili.mjs'))) return c } catch {} }
  return null
}

/** B站：跑 debrief（元信息+字幕+弹幕热区+热评+抽帧路径）。返回结构化素材。 */
export async function fetchBilibili(bvid, { withFrames = true, timeoutMs } = {}) {
  const root = biliWhaleRoot()
  const node = resolveNode()
  if (!root) throw new Error('找不到 dsh-bili-whale 工具链（插件未安装？）——可改用字幕/文字稿手动录入')
  if (!node) throw new Error('找不到可用的 node 运行时（设 DSH_NODE 环境变量）')
  const bili = path.join(root, 'tools', 'bili.mjs')
  const args = ['debrief', bvid, ...(withFrames ? [] : ['--no-frames'])]
  const budget = timeoutMs ?? (withFrames ? 1_800_000 : 180_000)
  const { stdout } = await execFileAsync(node, [bili, ...args], { timeout: budget, maxBuffer: 32 * 1024 * 1024, windowsHide: true, cwd: path.join(root, 'tools') })
  const out = String(stdout || '')
  const pick = (label) => (out.match(new RegExp('^' + label + ':\\s*(.+)$', 'm')) || [])[1]?.trim() || null
  const subtitle = (() => {
    const m = out.match(/有字幕：(\d+) 行[^\n]*→\s*(\S+\.txt)/)
    return m ? { lines: Number(m[1]), file: m[2] } : null
  })()
  return {
    platform: 'bilibili', bvid, raw: out,
    title: (out.match(/^标题:\s*(.+)$/m) || [])[1]?.trim() || '',
    subtitle, sheet: pick('SHEET'), subs: pick('SUBS'),
    imageHint: 'SHEET=九宫格画面帧，SUBS=字幕带拼图，subtitle.file=官方字幕全文 → 交给 read_image / 文件读取',
  }
}

/** YouTube / 通用网页：抓 og: 元信息（标题/作者/时长/描述/封面）。不出网以外的权限，不登录。 */
export async function fetchWeb(url, { timeoutMs = 20000 } = {}) {
  const controller = new AbortController()
  const t = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      signal: controller.signal, redirect: 'follow',
      headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36', 'accept-language': 'zh-CN,zh;q=0.9' },
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}（需要登录/会员/地区权限？或视频已删除）`)
    const html = (await res.text()).slice(0, 2_000_000)
    const meta = (name) => {
      const m = html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${name}["'][^>]+content=["']([^"']+)["']`, 'i'))
        || html.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${name}["']`, 'i'))
      return m ? decodeEntities(m[1]) : null
    }
    const title = meta('og:title') || (html.match(/<title[^>]*>([^<]+)<\/title>/i) || [])[1] || ''
    return {
      platform: 'web', url, title: title.trim(),
      description: meta('og:description') || meta('description') || '',
      author: meta('video:tag') || meta('author') || (html.match(/"author":\{"@type":"Person","name":"([^"]+)"/) || [])[1] || '',
      duration: meta('video:duration') || (html.match(/"lengthSeconds":"(\d+)"/) || [])[1] || '',
      thumbnail: meta('og:image') || '',
      publishedAt: meta('article:published_time') || (html.match(/"publishDate":"([^"]+)"/) || [])[1] || '',
      note: '仅拿到网页元信息（无字幕/正文）→ 置信度上限 0.4，必须请用户补字幕/文字稿，或说明缺失。',
    }
  } finally { clearTimeout(t) }
}

const decodeEntities = (s) => String(s)
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
