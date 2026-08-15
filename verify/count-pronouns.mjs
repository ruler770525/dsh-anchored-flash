/**
 * Pronoun fingerprint counter for an anchored-flash test session.
 * Scans every assistant message's reasoning text and counts the
 * trajectory fingerprints: `we`, `let's`, `let me` (case-insensitive,
 * whole-word, community counting style).
 * Usage: node count-pronouns.mjs <session-dir>
 */
import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const dir = process.argv[2]
if (!dir) { console.error('usage: node count-pronouns.mjs <session-dir>'); process.exit(1) }

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

const count = (text, re) => (text.match(re) ?? []).length

let total = { we: 0, lets: 0, letMe: 0, msgs: 0 }
console.log('=== per assistant message ===')
for (const r of records) {
  if (r.type !== 'assistant/message') continue
  const msg = r.data?.message ?? {}
  const reasoning = (msg.content ?? []).filter((c) => c.type === 'reasoning').map((c) => c.text).join('\n')
  const text = (msg.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n')
  const firstLine = (reasoning.split('\n').find((l) => l.trim()) || text.split('\n').find((l) => l.trim()) || '').trim()
  const nWe = count(reasoning, /\bwe\b/gi)
  const nLets = count(reasoning, /\blet'?s\b/gi)
  const nLetMe = count(reasoning, /\blet\s+me\b/gi)
  total.we += nWe; total.lets += nLets; total.letMe += nLetMe; total.msgs++
  console.log(`turn ${msg.source?.model ?? '?'} | reasoning ${reasoning.length} chars | we=${nWe} let's=${nLets} let me=${nLetMe}`)
  console.log(`  1st: ${firstLine.slice(0, 110)}`)
}
console.log('\n=== totals ===')
console.log(`messages: ${total.msgs}, we=${total.we}, let's=${total.lets}, let me=${total.letMe}`)
const verdict = total.letMe === 0 && total.we > 0 ? 'ANCHORED (we-style)' : total.letMe > 0 ? 'STANDARD-LIKE (let me present)' : 'NEUTRAL (no fingerprint)'
console.log(`verdict: ${verdict}`)
