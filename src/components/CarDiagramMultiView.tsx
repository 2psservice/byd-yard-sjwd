/**
 * Multi-angle car damage diagram — Top / Front / Rear / Left / Right
 * Uses car-top.png for the top view; SVG outlines for the other 4 angles.
 */
import { CarTopView } from './CarTopView'

export type CarView = 'top' | 'front' | 'rear' | 'left' | 'right'

export const VIEW_LABELS: Record<CarView, string> = {
  top: 'บน', front: 'หน้า', rear: 'ท้าย', left: 'ซ้าย', right: 'ขวา',
}

export type ZoneDef = { id: string; th: string; en: string; x: number; y: number }

const TOP_ZONES: ZoneDef[] = [
  { id: 'front',  th: 'กันชนหน้า',      en: 'Front bumper', x: 50, y: 7  },
  { id: 'bonnet', th: 'ฝากระโปรง',      en: 'Bonnet',       x: 50, y: 22 },
  { id: 'fl',     th: 'ประตูหน้าซ้าย',  en: 'Front-L door', x: 15, y: 38 },
  { id: 'fr',     th: 'ประตูหน้าขวา',   en: 'Front-R door', x: 85, y: 38 },
  { id: 'roof',   th: 'หลังคา',         en: 'Roof',         x: 50, y: 50 },
  { id: 'rl',     th: 'ประตูหลังซ้าย',  en: 'Rear-L door',  x: 15, y: 64 },
  { id: 'rr',     th: 'ประตูหลังขวา',   en: 'Rear-R door',  x: 85, y: 64 },
  { id: 'rear',   th: 'กันชนหลัง',      en: 'Rear bumper',  x: 50, y: 93 },
]

const FRONT_ZONES: ZoneDef[] = [
  { id: 'fv-hood',     th: 'ฝากระโปรงหน้า',   en: 'Hood',         x: 50, y: 17 },
  { id: 'fv-wshield',  th: 'กระจกหน้า',        en: 'Windshield',   x: 50, y: 46 },
  { id: 'fv-hl-l',     th: 'ไฟหน้าซ้าย',       en: 'Headlight L',  x: 19, y: 40 },
  { id: 'fv-hl-r',     th: 'ไฟหน้าขวา',        en: 'Headlight R',  x: 81, y: 40 },
  { id: 'fv-mirror-l', th: 'กระจกมองซ้าย',     en: 'Mirror L',     x: 5,  y: 42 },
  { id: 'fv-mirror-r', th: 'กระจกมองขวา',      en: 'Mirror R',     x: 95, y: 42 },
  { id: 'fv-bumper',   th: 'กันชนหน้า',         en: 'Front bumper', x: 50, y: 88 },
]

const REAR_ZONES: ZoneDef[] = [
  { id: 'rv-trunk',    th: 'ฝากระโปรงหลัง', en: 'Trunk lid',    x: 50, y: 17 },
  { id: 'rv-wshield',  th: 'กระจกหลัง',      en: 'Rear window',  x: 50, y: 44 },
  { id: 'rv-tl-l',     th: 'ไฟท้ายซ้าย',     en: 'Taillight L',  x: 19, y: 42 },
  { id: 'rv-tl-r',     th: 'ไฟท้ายขวา',      en: 'Taillight R',  x: 81, y: 42 },
  { id: 'rv-bumper',   th: 'กันชนหลัง',       en: 'Rear bumper',  x: 50, y: 86 },
]

// Left-side zones — front of car is on the LEFT of the SVG
const LEFT_ZONES: ZoneDef[] = [
  { id: 'lv-roof',         th: 'หลังคา',          en: 'Roof',          x: 50, y: 30 },
  { id: 'lv-wshield',      th: 'กระจกหน้า',       en: 'Windshield',    x: 31, y: 30 },
  { id: 'lv-front-fender', th: 'ปีกหน้าซ้าย',    en: 'Front fender L', x: 12, y: 71 },
  { id: 'lv-front-door',   th: 'ประตูหน้าซ้าย',  en: 'Front door L',  x: 37, y: 68 },
  { id: 'lv-rear-door',    th: 'ประตูหลังซ้าย',  en: 'Rear door L',   x: 60, y: 68 },
  { id: 'lv-rear-fender',  th: 'ปีกหลังซ้าย',   en: 'Rear fender L', x: 84, y: 71 },
  { id: 'lv-rocker',       th: 'ขอบล่างซ้าย',    en: 'Rocker L',      x: 49, y: 89 },
]

// Right-side zones — SVG is mirrored scaleX(-1), so x = 100 - left_x
const RIGHT_ZONES: ZoneDef[] = [
  { id: 'rv2-roof',         th: 'หลังคา',         en: 'Roof',          x: 50, y: 30 },
  { id: 'rv2-wshield',      th: 'กระจกหน้า',      en: 'Windshield',    x: 69, y: 30 },
  { id: 'rv2-front-fender', th: 'ปีกหน้าขวา',    en: 'Front fender R', x: 88, y: 71 },
  { id: 'rv2-front-door',   th: 'ประตูหน้าขวา',  en: 'Front door R',  x: 63, y: 68 },
  { id: 'rv2-rear-door',    th: 'ประตูหลังขวา',  en: 'Rear door R',   x: 40, y: 68 },
  { id: 'rv2-rear-fender',  th: 'ปีกหลังขวา',   en: 'Rear fender R', x: 16, y: 71 },
  { id: 'rv2-rocker',       th: 'ขอบล่างขวา',    en: 'Rocker R',      x: 51, y: 89 },
]

export const VIEW_ZONES: Record<CarView, ZoneDef[]> = {
  top: TOP_ZONES, front: FRONT_ZONES, rear: REAR_ZONES,
  left: LEFT_ZONES, right: RIGHT_ZONES,
}

export const ALL_ZONES: ZoneDef[] = [
  ...TOP_ZONES, ...FRONT_ZONES, ...REAR_ZONES, ...LEFT_ZONES, ...RIGHT_ZONES,
]

export const zoneLabel = (id: string, lang: 'th' | 'en' = 'th') => {
  const z = ALL_ZONES.find(z => z.id === id)
  return z ? z[lang] : id
}

// ── SVG car outlines ─────────────────────────────────────────────────────────

function FrontCarSVG({ w }: { w: number }) {
  const h = Math.round(w * 200 / 220)
  return (
    <svg width={w} height={h} viewBox="0 0 220 200" xmlns="http://www.w3.org/2000/svg" style={{ display: 'block' }}>
      <rect x="58" y="5" width="104" height="18" rx="9" fill="#e5e9f0" stroke="#c8d0dc" strokeWidth="1.5"/>
      <path d="M30 22 L190 22 L196 70 L24 70 Z" fill="#edf0f5" stroke="#c8d0dc" strokeWidth="1.5"/>
      <path d="M64 72 L156 72 L152 118 L68 118 Z" fill="#d4e8f8" stroke="#b8ccdc" strokeWidth="1.5"/>
      <path d="M24 70 L64 72 L68 118 L22 122" fill="#dde2ea" stroke="#c8d0dc" strokeWidth="1"/>
      <path d="M196 70 L156 72 L152 118 L198 122" fill="#dde2ea" stroke="#c8d0dc" strokeWidth="1"/>
      <rect x="24" y="70" width="40" height="22" rx="5" fill="#fef9e0" stroke="#d8c030" strokeWidth="1.5"/>
      <rect x="156" y="70" width="40" height="22" rx="5" fill="#fef9e0" stroke="#d8c030" strokeWidth="1.5"/>
      <rect x="20" y="118" width="180" height="38" rx="4" fill="#edf0f5" stroke="#c8d0dc" strokeWidth="1.5"/>
      <rect x="72" y="126" width="76" height="20" rx="5" fill="#c8cdd8" stroke="#aab0be" strokeWidth="1"/>
      <rect x="14" y="156" width="192" height="30" rx="8" fill="#dde0e8" stroke="#c8cdd8" strokeWidth="1.5"/>
      <rect x="4" y="76" width="22" height="12" rx="3" fill="#cdd2da" stroke="#b0b8c4" strokeWidth="1"/>
      <rect x="194" y="76" width="22" height="12" rx="3" fill="#cdd2da" stroke="#b0b8c4" strokeWidth="1"/>
      <ellipse cx="110" cy="30" rx="16" ry="7" fill="#d0d4dc" stroke="#b0b8c4" strokeWidth="1"/>
    </svg>
  )
}

function RearCarSVG({ w }: { w: number }) {
  const h = Math.round(w * 200 / 220)
  return (
    <svg width={w} height={h} viewBox="0 0 220 200" xmlns="http://www.w3.org/2000/svg" style={{ display: 'block' }}>
      <rect x="58" y="5" width="104" height="18" rx="9" fill="#e5e9f0" stroke="#c8d0dc" strokeWidth="1.5"/>
      <path d="M32 22 L188 22 L194 65 L26 65 Z" fill="#edf0f5" stroke="#c8d0dc" strokeWidth="1.5"/>
      <path d="M60 67 L160 67 L164 110 L56 110 Z" fill="#d4e8f8" stroke="#b8ccdc" strokeWidth="1.5"/>
      <path d="M26 65 L60 67 L56 110 L22 114" fill="#dde2ea" stroke="#c8d0dc" strokeWidth="1"/>
      <path d="M194 65 L160 67 L164 110 L198 114" fill="#dde2ea" stroke="#c8d0dc" strokeWidth="1"/>
      <rect x="20" y="68" width="42" height="26" rx="5" fill="#ffe0dc" stroke="#d84040" strokeWidth="1.5"/>
      <rect x="22" y="70" width="38" height="9" rx="3" fill="#ff6060" opacity="0.5"/>
      <rect x="158" y="68" width="42" height="26" rx="5" fill="#ffe0dc" stroke="#d84040" strokeWidth="1.5"/>
      <rect x="160" y="70" width="38" height="9" rx="3" fill="#ff6060" opacity="0.5"/>
      <rect x="20" y="110" width="180" height="36" rx="4" fill="#edf0f5" stroke="#c8d0dc" strokeWidth="1.5"/>
      <rect x="74" y="118" width="72" height="20" rx="3" fill="#d8dce8" stroke="#b0b8c4" strokeWidth="1"/>
      <rect x="14" y="146" width="192" height="38" rx="8" fill="#dde0e8" stroke="#c8cdd8" strokeWidth="1.5"/>
      <rect x="97" y="27" width="26" height="9" rx="3" fill="#d0d4dc" stroke="#b0b8c4" strokeWidth="1"/>
    </svg>
  )
}

function SideCarSVG({ w, flip }: { w: number; flip?: boolean }) {
  const h = Math.round(w * 150 / 340)
  return (
    <svg width={w} height={h} viewBox="0 0 340 150" xmlns="http://www.w3.org/2000/svg"
      style={{ display: 'block', transform: flip ? 'scaleX(-1)' : undefined }}>
      {/* main body */}
      <path d="M18 93 L22 138 L318 138 L322 93 L282 90 L242 64 L104 64 L58 90 Z"
        fill="#edf0f5" stroke="#c8d0dc" strokeWidth="1.5"/>
      {/* roof */}
      <path d="M100 62 L112 34 L240 34 L250 62 Z" fill="#e5e9f0" stroke="#c8d0dc" strokeWidth="1.5"/>
      {/* front windshield */}
      <path d="M112 34 L100 62 L113 62 L133 34 Z" fill="#d4e8f8" stroke="#b8ccdc" strokeWidth="1.5"/>
      {/* rear windshield */}
      <path d="M240 34 L250 62 L238 62 L218 34 Z" fill="#d4e8f8" stroke="#b8ccdc" strokeWidth="1.5"/>
      {/* front side window */}
      <rect x="116" y="36" width="52" height="26" rx="2" fill="#d4e8f8" stroke="#b8ccdc" strokeWidth="1"/>
      {/* rear side window */}
      <rect x="172" y="36" width="44" height="26" rx="2" fill="#d4e8f8" stroke="#b8ccdc" strokeWidth="1"/>
      {/* B-pillar */}
      <rect x="165" y="62" width="7" height="74" rx="1" fill="#c8cdd8"/>
      {/* front headlight */}
      <rect x="14" y="88" width="24" height="16" rx="4" fill="#fef9e0" stroke="#d8c030" strokeWidth="1.5"/>
      {/* rear taillight */}
      <rect x="302" y="88" width="24" height="16" rx="4" fill="#ffe0dc" stroke="#d84040" strokeWidth="1.5"/>
      {/* rocker panel */}
      <rect x="58" y="131" width="224" height="8" rx="2" fill="#d8dce8" stroke="#b8c0d0" strokeWidth="1"/>
      {/* front wheel arch */}
      <path d="M18 93 L58 90 L58 138 L22 138 Z" fill="#e5e9f2" stroke="#c8d0dc" strokeWidth="1"/>
      {/* rear wheel arch */}
      <path d="M282 90 L322 93 L318 138 L282 138 Z" fill="#e5e9f2" stroke="#c8d0dc" strokeWidth="1"/>
      {/* front wheel */}
      <circle cx="68" cy="138" r="17" fill="none" stroke="#8090a0" strokeWidth="2"/>
      <circle cx="68" cy="138" r="9" fill="#c8cdd8" stroke="#8090a0" strokeWidth="1"/>
      {/* rear wheel */}
      <circle cx="272" cy="138" r="17" fill="none" stroke="#8090a0" strokeWidth="2"/>
      <circle cx="272" cy="138" r="9" fill="#c8cdd8" stroke="#8090a0" strokeWidth="1"/>
      {/* mirror */}
      <rect x="88" y="62" width="20" height="10" rx="3" fill="#cdd2da" stroke="#b0b8c4" strokeWidth="1"/>
    </svg>
  )
}

// ── main component ────────────────────────────────────────────────────────────

export function CarDiagramMultiView({
  selectedZone, onSelect, view, onViewChange,
}: {
  selectedZone: string
  onSelect: (id: string) => void
  view: CarView
  onViewChange: (v: CarView) => void
}) {
  const zones = VIEW_ZONES[view]
  const isSide = view === 'left' || view === 'right'
  const isTop = view === 'top'

  const carW = isSide ? 230 : isTop ? 128 : 160
  const carH = isTop
    ? Math.round(carW * 691 / 351)
    : isSide
    ? Math.round(carW * 150 / 340)
    : Math.round(carW * 200 / 220)

  return (
    <div>
      {/* view tabs */}
      <div className="flex gap-1 mb-2.5 justify-center flex-wrap">
        {(['top', 'front', 'rear', 'left', 'right'] as CarView[]).map(v => (
          <button
            key={v}
            onClick={() => { onViewChange(v); onSelect(VIEW_ZONES[v][0].id) }}
            className="text-[11.5px] px-3 py-1 rounded-lg font-semibold transition"
            style={view === v
              ? { background: '#1b2330', color: '#fff' }
              : { background: 'var(--chip)', color: 'var(--muted)' }}
          >
            {VIEW_LABELS[v]}
          </button>
        ))}
      </div>

      {/* diagram */}
      <div className="relative mx-auto" style={{ width: carW, height: carH }}>
        {isTop ? (
          <CarTopView color="#cfd6dd" width={carW} />
        ) : view === 'front' ? (
          <FrontCarSVG w={carW} />
        ) : view === 'rear' ? (
          <RearCarSVG w={carW} />
        ) : (
          <SideCarSVG w={carW} flip={view === 'right'} />
        )}

        {/* clickable zone dots */}
        {zones.map(z => (
          <button
            key={z.id}
            onClick={() => onSelect(z.id)}
            className="absolute -translate-x-1/2 -translate-y-1/2 rounded-full border-2 transition-all"
            style={{
              left: `${z.x}%`, top: `${z.y}%`,
              width: 20, height: 20, zIndex: 2,
              background: selectedZone === z.id ? 'var(--st-damage)' : 'rgba(255,255,255,0.88)',
              borderColor: selectedZone === z.id ? '#fff' : 'var(--line-strong)',
              boxShadow: selectedZone === z.id
                ? '0 0 10px 3px rgba(239,68,68,0.5)'
                : '0 1px 3px rgba(0,0,0,0.2)',
            }}
            title={z.th}
          />
        ))}
      </div>

      {/* selected zone label */}
      <div className="text-center text-[12.5px] font-semibold mt-1.5" style={{ color: 'var(--st-damage)' }}>
        {zones.find(z => z.id === selectedZone)?.th ?? '—'}
      </div>
    </div>
  )
}
