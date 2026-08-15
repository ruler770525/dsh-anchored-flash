/**
 * Dump a DSH session JSONL (zstd frames) for diagnosis:
 * request/header tools+maxTokens, first user message sources,
 * assistant reasoning first lines.
 * Usage: node dump-session.mjs <session-dir>
 */
import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const dir = process.argv[2]
if (!dir) { console.error('usage: node dump-session.mjs <session-dir>'); process.exit(1) }

const buf = readFileSync(`${dir}/session.jsonl.zstd`)
// zstd frame magic 28 B5 2F FD (little-endian)
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const frames = []
let i = 0
while (i < buf.length - 4) {
  if (buf.subarray(i, i + 4).equals(MAGIC)) {
    // scan frame end: next magic or EOF; frames may be concatenated
    let j = i + 4
    let next = buf.indexOf(MAGIC, j)
    if (next === -1) next = buf.length
    frames.push(buf.subarray(i, next))
    i = next
  } else {
    i++
  }
}
console.log(`frames: ${frames.length}, total bytes: ${buf.length}`)
const plain = frames.map((f) => zstdDecompressSync(f).toString('utf8')).join('')
const lines = plain.split('\n').filter((l) => l.trim().length > 0)
console.log(`jsonl records: ${lines.length}`)

const records = lines.map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)

let headerCount = 0
let firstUserShown = false
for (const r of records) {
  const t = r.type
  if (t === 'request/header') {
    headerCount++
    const d = r.data ?? {}
    const h = d.header ?? {}
    const toolsRaw = h.tools ?? h.config?.tools
    const tools = Array.isArray(toolsRaw) ? toolsRaw.map((x) => (typeof x === 'string' ? x : x.name)).join(',') : JSON.stringify(toolsRaw)
    console.log(`\n[request/header #${headerCount}]`)
    console.log(`  reason: ${JSON.stringify(d.reason)}`)
    console.log(`  header keys: ${Object.keys(h).join(',')}`)
    console.log(`  config: ${JSON.stringify(h.config).slice(0, 500)}`)
    console.log(`  tools: ${typeof tools === 'string' ? `(${tools.split(',').length}) ${tools}` : tools}`)
    if (headerCount <= 2) {
      const sys = h.system ?? ''
      const sysText = typeof sys === 'string' ? sys : JSON.stringify(sys)
      console.log(`  system[0:900]: ${sysText.slice(0, 900).replace(/\n/g, '\\n')}`)
    }
  } else if (t === 'user/message' && !firstUserShown) {
    firstUserShown = true
    const src = r.data?.source ?? r.data?.meta?.source
    const text = typeof r.data?.content === 'string' ? r.data.content
      : Array.isArray(r.data?.content) ? r.data.content.map((c) => (typeof c === 'object' && c !== null && c.type === 'text' ? c.text : '')).join(' ')
      : ''
    console.log(`\n[first user/message]`)
    console.log(`  source: ${JSON.stringify(src ?? null)}`)
    console.log(`  content[0:600]: ${text.slice(0, 600).replace(/\n/g, '\\n')}`)
  } else if (t === 'assistant/message') {
    const d = r.data ?? {}
    const reasoning = d.reasoning ?? d.meta?.reasoning ?? ''
    const firstLine = typeof reasoning === 'string' ? reasoning.split('\n').find((l) => l.trim()) : ''
    const contentText = typeof d.content === 'string' ? d.content
      : Array.isArray(d.content) ? d.content.map((c) => (typeof c === 'object' && c !== null && c.type === 'text' ? c.text : '')).join(' ')
      : ''
    const contentFirst = typeof contentText === 'string' ? contentText.split('\n').find((l) => l.trim()) ?? '' : ''
    const fp = (firstLine || contentFirst).slice(0, 150)
    if (firstLine === '' && contentFirst === '') {
      console.log(`[assistant] keys: ${Object.keys(d).join(',')}`)
    } else {
      console.log(`[assistant] 1st: ${fp}`)
    }
  }
}
