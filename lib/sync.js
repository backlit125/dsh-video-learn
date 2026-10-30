// lib/sync.js —— 学习日志落盘：本地 md 永远写（主档/兜底）；云端尽力而为，失败不阻塞闭环
//
// 后端（config.storage）：
//   local   = 只写本地
//   notion  = 内置 Notion 写入器（lib/notion.js，无外部依赖）
//   command = 调用 config.syncCommand 指定的外部脚本（主人本机可指向自己的三处同写脚本）
// ⚠ 不内置任何"某个具体用户的私有路径"—— 换机器装上就能用。
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { writePage, hasCredentials } from './notion.js'
import { resolveNode } from './fetcher.js'

const execFileAsync = promisify(execFile)
const HOME = process.env.USERPROFILE || process.env.HOME || os.homedir()

export function makeSync(dir, cfg = {}) {
  const OUT = path.join(dir, 'notes')
  fs.mkdirSync(OUT, { recursive: true })

  /** 本地 md：永远成功，是主档与兜底。 */
  function writeLocal(fileName, markdown) {
    const safe = String(fileName).replace(/[\\/:*?"<>|]/g, '_').slice(0, 120)
    const file = path.join(OUT, safe + '.md')
    fs.writeFileSync(file, markdown, 'utf8')
    return file
  }

  /** 内置 Notion 写入（凭证：config ← 环境变量 ← ~/.dsh/notion.json）。 */
  async function toNotion({ title, markdown }) {
    if (!hasCredentials(cfg)) return { ok: false, skipped: true, reason: '未配置 Notion 凭证 → 只写本地' }
    const stamp = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' }).slice(0, 16)
    return writePage({ title: `${stamp} · ${cfg.project || '视频学习'} · ${title}`, markdown, cfg })
  }

  /** 外部脚本（可选）：config.syncCommand = "node path/to/x.mjs"，正文经 --bodyfile 传入。 */
  async function toCommand({ title, project, markdown }) {
    const cmd = String(cfg.syncCommand || '').trim()
    if (!cmd) return { ok: false, skipped: true, reason: '未配置 syncCommand → 只写本地' }
    const bodyFile = path.join(OUT, `.sync-${Date.now()}.md`)
    fs.writeFileSync(bodyFile, markdown, 'utf8')
    const [exe, ...head] = cmd.split(/\s+/)
    const bin = exe === 'node' ? (resolveNode() || process.execPath) : exe
    try {
      const { stdout } = await execFileAsync(bin, [...head, '--title', title, '--project', project || cfg.project || '视频学习', '--bodyfile', bodyFile],
        { timeout: Math.max(60_000, Number(cfg.syncTimeoutMs) || 600_000), maxBuffer: 8 * 1024 * 1024, windowsHide: true })
      const out = String(stdout || '')
      // ⚠ 只取"裸 URL"：外层 JSON.stringify 会把引号转义成 \"，
      //   贪婪的 \S+ 会把 \"local\":\"... 一并吞进来（2026-10-30 实测踩过）
      const url = (out.match(/https:\/\/[^\s"\\]+notion[^\s"\\]*|https:\/\/[^\s"\\]+onenote[^\s"\\]*/i) || [])[0] || null
      if (/"ok"\s*:\s*true/.test(out) || url) return { ok: true, url, via: 'command', raw: out.slice(-300) }
      return { ok: false, reason: ('外部同步脚本返回异常：' + out).slice(0, 400) }
    } catch (e) {
      return { ok: false, reason: ('外部同步脚本失败：' + String(e?.stderr || e?.message || e)).slice(0, 400) }
    } finally { try { fs.rmSync(bodyFile, { force: true }) } catch {} }
  }

  /** 统一入口：本地必写；云端按 storage 选后端，失败只警告不抛错。 */
  async function publish({ fileName, title, project, markdown, backend }) {
    const local = writeLocal(fileName, markdown)
    const result = { ok: true, local }
    const want = backend || cfg.storage || 'local'
    if (want === 'local') { result.cloud = { ok: false, skipped: true, reason: 'storage=local' }; return result }
    result.cloud = want === 'command'
      ? await toCommand({ title, project, markdown })
      : await toNotion({ title, markdown })
    if (result.cloud.skipped) result.note = '云端未配置 → 已落本地；配好凭证后把 storage 设为 notion 即可补同步'
    else if (!result.cloud.ok) result.cloudWarn = result.cloud.reason
    return result
  }

  /** 复习记录：本地另存一份，云端作为独立子页追加。 */
  async function appendReview({ fileName, title, reviewMarkdown }) {
    const local = writeLocal(fileName + '-复习', reviewMarkdown)
    const cloud = await toNotion({ title: `[复习] ${title}`, markdown: reviewMarkdown })
    return { ok: true, local, cloud }
  }

  return { publish, appendReview, toNotion, toCommand, writeLocal, dir: OUT,
    channels: { notion: hasCredentials(cfg), command: Boolean(cfg.syncCommand), storage: cfg.storage || 'local' } }
}
