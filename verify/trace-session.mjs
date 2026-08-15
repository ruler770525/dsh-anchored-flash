/**
 * Full trajectory trace: headers + assistant reasoning fingerprints +
 * tool calls/results, in sequence. Usage: node trace-session.mjs <session-dir>
 */
import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const dir = process.argv[2]
const buf = readFileSync(`${dir}/session.jsonl.zstd`)
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const frames = []
let i = 0
while (i < buf.length - 4) {
  if (buf.subarray(i, i + 4).equals(MAGIC)) {
    let j = i + 4
    let next = buf.indexOf(MAGIC, j)
    if (next === -1) next = buf.length
    frames.push(buf.subarray(i, next))
    i = next
  } else i++
}
const records = frames.map((f) => zstdDecompressSync(f).toString('utf8')).join('').split('\n').filter(Boolean)
  .map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)

let hdr = 0
for (const r of records) {
  const t = r.type
  if (t === 'request/header') {
    hdr++
    const h = r.data?.header ?? {}
    const names = Array.isArray(h.tools) ? h.tools.map((x) => x.name ?? x).join(',') : '?'
    const sysLen = typeof h.system === 'string' ? h.system.length : 0
    console.log(`[header#${hdr}] ${r.data?.reason ?? ''} | tools(${Array.isArray(h.tools) ? h.tools.length : '?'}): ${names.slice(0, 180)} | system ${sysLen} chars | maxTokens ${JSON.stringify(h.config?.maxTokens)}`)
    if (hdr === 1 && typeof h.system === 'string') console.log(`  system: ${h.system.slice(0, 80).replace(/\n/g, ' | ')}`)
  } else if (t === 'tool/call') {
    const msg = r.data?.message ?? r.data ?? {}
    console.log(`[tool/call] ${msg.name ?? '?'} ${String(msg.arguments ?? '').slice(0, 110)}`)
  } else if (t === 'tool/result') {
    const c = r.data?.message?.content ?? []
    const txt = JSON.stringify(c)
    const isErr = txt.includes('isError":true') || txt.includes('Error:')
    console.log(`[tool/result] ${isErr ? 'ERROR' : 'ok'} ${txt.slice(0, 150)}`)
  } else if (t === 'assistant/message') {
    const msg = r.data?.message ?? {}
    const reas = (msg.content ?? []).filter((c) => c.type === 'reasoning').map((c) => c.text).join('')
    const first = reas.split('\n').find((l) => l.trim()) ?? ''
    const we = (reas.match(/\bwe\b/gi) ?? []).length
    const lm = (reas.match(/\blet\s+me\b/gi) ?? []).length
    const ls = (reas.match(/\blet'?s\b/gi) ?? []).length
    console.log(`[assistant] turn=${r.data?.turn} step=${r.data?.step} r=${reas.length} we=${we} lets=${ls} letMe=${lm}`)
    console.log(`   1st: ${first.slice(0, 130)}`)
  }
}
