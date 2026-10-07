#!/usr/bin/env node
// สำรองข้อมูล Supabase ทุกตารางของแอป → โฟลเดอร์ backups/<วันเวลา>/ (ไฟล์ละตาราง, NDJSON)
//
// วิธีใช้ (บนคอมที่มี Node 18+):
//   VITE_SUPABASE_URL=https://xxxx.supabase.co VITE_SUPABASE_ANON_KEY=eyJ... node scripts/backup-supabase.mjs
//   หรือมีไฟล์ .env.local อยู่ในโฟลเดอร์โปรเจกต์ก็อ่านให้เอง
//
// - อ่านอย่างเดียว ไม่เขียนอะไรลงฐานข้อมูล
// - ดึงทีละ 1000 แถว (keyset ตามคีย์) จนครบ แล้วเทียบยอดกับ count ของฐานข้อมูล — ไม่ตรง = FAIL
// - damages มีรูป base64 อาจใหญ่หลาย GB — ใช้ --no-photos เพื่อข้ามคอลัมน์รูป (ไฟล์เล็กลงมาก)
//   แต่ "สำรองจริงก่อนแก้โครง" ควรเอารูปด้วยอย่างน้อยหนึ่งชุด
// - กู้คืน: ใช้ scripts/restore-supabase.mjs (ยังไม่มี — จะเขียนเมื่อถึงขั้นที่ต้องใช้) หรือ
//   นำเข้าผ่าน Table Editor → Import CSV (แปลง NDJSON → CSV ได้ด้วย jq/excel)
import { mkdirSync, writeFileSync, readFileSync, existsSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'

const args = new Set(process.argv.slice(2))
const noPhotos = args.has('--no-photos')

// ── env ───────────────────────────────────────────────────────────────────
function loadEnv() {
  const out = { url: process.env.VITE_SUPABASE_URL, key: process.env.VITE_SUPABASE_ANON_KEY }
  if ((!out.url || !out.key) && existsSync('.env.local')) {
    for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
      const m = /^\s*(VITE_SUPABASE_URL|VITE_SUPABASE_ANON_KEY)\s*=\s*(.+?)\s*$/.exec(line)
      if (m) { if (m[1] === 'VITE_SUPABASE_URL') out.url ||= m[2]; else out.key ||= m[2] }
    }
  }
  if (!out.url || !out.key) { console.error('ต้องตั้ง VITE_SUPABASE_URL และ VITE_SUPABASE_ANON_KEY (หรือมี .env.local)'); process.exit(2) }
  return out
}
const { url, key } = loadEnv()
const H = { apikey: key, Authorization: `Bearer ${key}` }

// ตาราง + คอลัมน์คีย์ที่ใช้ไล่หน้า (ต้องเรียงได้และไม่ซ้ำ)
const TABLES = [
  { name: 'sites', key: 'id' },
  { name: 'blocks', key: 'id', key2: 'site_id' },
  { name: 'trailers', key: 'no', key2: 'site_id' },
  { name: 'app_users', key: 'id' },
  { name: 'app_config', key: 'id' },
  { name: 'ops_queues', key: 'id' },
  { name: 'visits', key: 'id' },
  { name: 'tracking_rows', key: 'vin' },
  { name: 'units', key: 'vin' },
  { name: 'damages', key: 'id', select: noPhotos ? '*' : '*', dropCols: noPhotos ? ['photo_url', 'photo_urls'] : [] },
]

async function count(name) {
  const r = await fetch(`${url}/rest/v1/${name}?select=*`, { method: 'HEAD', headers: { ...H, Prefer: 'count=exact', Range: '0-0' } })
  if (!r.ok && r.status !== 206 && r.status !== 416) throw new Error(`${name} count HTTP ${r.status}`)
  const cr = r.headers.get('content-range') || ''
  const total = Number(cr.split('/')[1])
  return Number.isFinite(total) ? total : null
}

async function dumpTable(t, dir) {
  const file = join(dir, `${t.name}.ndjson`)
  writeFileSync(file, '')
  const PAGE = 1000
  let after = null
  let n = 0
  for (;;) {
    const order = t.key2 ? `${t.key2}.asc,${t.key}.asc` : `${t.key}.asc`
    // keyset: หน้าถัดไปคือ "หลังคีย์สุดท้าย" — สำหรับคีย์คู่ใช้ offset แทน (ตารางเล็ก)
    let q = `${url}/rest/v1/${t.name}?select=*&order=${order}&limit=${PAGE}`
    if (t.key2) q += `&offset=${n}`
    else if (after !== null) q += `&${t.key}=gt.${encodeURIComponent(after)}`
    const r = await fetch(q, { headers: H })
    if (!r.ok) throw new Error(`${t.name} page HTTP ${r.status}: ${await r.text()}`)
    const rows = await r.json()
    if (!rows.length) break
    const lines = rows.map((row) => {
      if (t.dropCols?.length) for (const c of t.dropCols) delete row[c]
      return JSON.stringify(row)
    })
    appendFileSync(file, lines.join('\n') + '\n')
    n += rows.length
    after = rows[rows.length - 1][t.key]
    process.stdout.write(`\r  ${t.name}: ${n} แถว`)
    if (rows.length < PAGE) break
  }
  process.stdout.write('\n')
  return n
}

;(async () => {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const dir = join('backups', stamp + (noPhotos ? '-nophotos' : ''))
  mkdirSync(dir, { recursive: true })
  console.log(`สำรองไป ${dir}/ จาก ${url}`)
  const summary = []
  let ok = true
  for (const t of TABLES) {
    const expected = await count(t.name).catch((e) => { console.log(`  ${t.name}: นับไม่ได้ (${e.message})`); return null })
    let got = 0
    try { got = await dumpTable(t, dir) } catch (e) { console.log(`  ${t.name}: FAIL ${e.message}`); ok = false; summary.push({ table: t.name, expected, got: null, ok: false }); continue }
    const match = expected === null || expected === got
    if (!match) ok = false
    summary.push({ table: t.name, expected, got, ok: match })
    console.log(`  ${t.name}: ${got}/${expected ?? '?'} ${match ? 'OK' : 'ไม่ครบ!'}`)
  }
  writeFileSync(join(dir, '_summary.json'), JSON.stringify({ url, at: stamp, noPhotos, tables: summary }, null, 2))
  console.log(ok ? `\nสำรองครบทุกตาราง → ${dir}/` : `\nมีตารางที่ไม่ครบ — ดู ${dir}/_summary.json แล้วรันใหม่`)
  process.exit(ok ? 0 : 1)
})().catch((e) => { console.error('ล้มเหลว:', e.message); process.exit(1) })
