/**
 * Deep-dive diagnosis: full system of header #1, message source sequence,
 * first assistant record structure.
 * Usage: node dive-session.mjs <session-dir>
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
const plain = frames.map((f) => zstdDecompressSync(f).toString('utf8')).join('')
const records = plain.split('\n').filter((l) => l.trim()).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)

console.log('=== record type sequence ===')
for (const r of records) console.log(`seq ${r.seq} ${r.type}`)

console.log('\n=== header #1 full system ===')
for (const r of records) {
  if (r.type === 'request/header' && r.data?.reason === 'initial') {
    console.log(r.data.header.system)
    break
  }
}

console.log('\n=== user/turn message sources (first 12) ===')
let shown = 0
for (const r of records) {
  if ((r.type === 'user/message' || r.type === 'turn/start' || r.type === 'agent/instructions' || r.type === 'assistant/message') && shown < 12) {
    const src = r.data?.source ?? r.data?.meta?.source
    const summary = r.data?.source?.summary ?? r.data?.meta?.source?.summary
    console.log(`seq ${r.seq} ${r.type} source=${JSON.stringify(src ?? null)} summary=${summary ?? ''}`)
    shown++
  }
}

console.log('\n=== first assistant/message full record (truncated) ===')
for (const r of records) {
  if (r.type === 'assistant/message') {
    console.log(JSON.stringify(r).slice(0, 2500))
    break
  }
}
