/**
 * Master Defect List — the two bilingual lists every defect picker offers:
 * PART (ตำแหน่ง: "A pillar LH / เสา A ซ้าย") and DEFECT (ข้อบกพร่อง:
 * "Paint Pin Hole / หลุมสี").
 *
 * They started as a generated copy of the office's Master_Defect_List workbook,
 * which meant a new part or a corrected Thai wording needed a code release. The
 * yard maintains these lists themselves, so they live here instead: the built-in
 * lists are the SEED, an admin's edits are stored on top, and every device gets
 * them through app_config + the sync bus like the other shared settings.
 *
 * Both languages are kept for every entry because they are used at both ends —
 * the field records in Thai, the office's reports read English — and a record
 * written from this list carries both so it can never end up half-translated.
 */
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import * as db from '../lib/db'
import { sendSync, onSync } from '../lib/syncBus'
import { MASTER_PARTS, MASTER_DEFECTS, type MasterEntry } from '../lib/masterDefectData'

export type { MasterEntry }
export type MasterKind = 'part' | 'defect'
const CONFIG_ID = 'master_defect_list'

const norm = (s: string) => (s ?? '').trim().toLowerCase()
const clean = (s: string) => (s ?? '').replace(/\s+/g, ' ').trim()

/** Stable id from the English name (Thai when there is no English). */
function makeId(en: string, th: string, taken: Set<string>): string {
  const base = (clean(en) || clean(th))
    .toLowerCase().replace(/[^a-z0-9ก-๙]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'entry'
  let id = base
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`
  return id
}

/** Anything the cloud/localStorage hands back, coerced to a usable list. */
function sanitize(list: unknown, fallback: MasterEntry[]): MasterEntry[] {
  if (!Array.isArray(list)) return fallback
  const out: MasterEntry[] = []
  const taken = new Set<string>()
  for (const raw of list) {
    const e = raw as Partial<MasterEntry>
    const en = clean(String(e?.en ?? '')), th = clean(String(e?.th ?? ''))
    if (!en && !th) continue
    const id = e?.id && !taken.has(String(e.id)) ? String(e.id) : makeId(en, th, taken)
    taken.add(id)
    out.push({ id, en, th })
  }
  return out
}

interface Saved { parts: MasterEntry[]; defects: MasterEntry[] }

interface MasterState extends Saved {
  /** Add a new entry, or edit one by id. Returns the id, or null when the
   *  English name already belongs to a DIFFERENT entry (the caller warns —
   *  two rows with one name would make the picker ambiguous). */
  upsert: (kind: MasterKind, e: { id?: string; en: string; th: string }) => string | null
  remove: (kind: MasterKind, id: string) => void
  /** Back to the list the app ships with — for when an edit session goes wrong. */
  resetToBuiltIn: (kind: MasterKind) => void
  loadFromCloud: () => Promise<void>
}

const listOf = (s: Saved, kind: MasterKind) => (kind === 'part' ? s.parts : s.defects)
const withList = (kind: MasterKind, list: MasterEntry[]) =>
  (kind === 'part' ? { parts: list } : { defects: list })

export const useMasterDefect = create<MasterState>()(
  persist(
    (set, get) => {
      const push = () => {
        const { parts, defects } = get()
        db.saveAppConfig(CONFIG_ID, { parts, defects } satisfies Saved)
          .then(() => sendSync('master'))
          .catch((e) => console.error('[master] save', e))
      }
      return {
        parts: MASTER_PARTS,
        defects: MASTER_DEFECTS,

        upsert: (kind, e) => {
          const en = clean(e.en), th = clean(e.th)
          if (!en && !th) return null
          const list = listOf(get(), kind)
          const clash = en && list.find((x) => norm(x.en) === norm(en) && x.id !== e.id)
          if (clash) return null
          if (e.id) {
            const next = list.map((x) => (x.id === e.id ? { ...x, en, th } : x))
            set(withList(kind, next)); push()
            return e.id
          }
          const id = makeId(en, th, new Set(list.map((x) => x.id)))
          set(withList(kind, [...list, { id, en, th }])); push()
          return id
        },

        remove: (kind, id) => {
          const list = listOf(get(), kind)
          if (!list.some((x) => x.id === id)) return
          set(withList(kind, list.filter((x) => x.id !== id))); push()
        },

        resetToBuiltIn: (kind) => {
          set(withList(kind, kind === 'part' ? MASTER_PARTS : MASTER_DEFECTS)); push()
        },

        loadFromCloud: async () => {
          const saved = await db.fetchAppConfig<Saved>(CONFIG_ID)
          if (!saved) return
          set({
            parts: sanitize(saved.parts, MASTER_PARTS),
            defects: sanitize(saved.defects, MASTER_DEFECTS),
          })
        },
      }
    },
    {
      name: 'sjwd-master-defect',
      partialize: (s) => ({ parts: s.parts, defects: s.defects }),
      merge: (persisted, current) => {
        const p = persisted as Partial<Saved> | undefined
        return {
          ...current,
          parts: sanitize(p?.parts, MASTER_PARTS),
          defects: sanitize(p?.defects, MASTER_DEFECTS),
        }
      },
    },
  ),
)

/** The live lists, for non-React callers (resolvePart / resolveDefect). */
export const liveParts = (): MasterEntry[] => useMasterDefect.getState().parts
export const liveDefects = (): MasterEntry[] => useMasterDefect.getState().defects

// another device edited the lists → pull them, so a picker never offers a part
// that was renamed on the office PC a moment ago
onSync('master', () => {
  useMasterDefect.getState().loadFromCloud().catch((e) => console.error('[master] sync pull', e))
})
