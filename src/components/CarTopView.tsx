/**
 * Realistic top-down vehicle photo (public/car-top.png).
 * Keeps the same { color, width } API as before; `color` now drives a soft
 * paint-tinted glow halo behind the car so different colours still read.
 */
const RATIO = 691 / 351 // natural height / width of car-top.png

export function CarTopView({ color = '#cfd6dd', width = 150 }: { color?: string; width?: number }) {
  const height = Math.round(width * RATIO)
  return (
    <div className="relative inline-flex items-center justify-center" style={{ width, height }}>
      {/* paint-coloured glow halo */}
      <div
        className="absolute pointer-events-none rounded-full"
        style={{
          width: width * 1.15,
          height: width * 1.15,
          background: `radial-gradient(circle, ${color}66, ${color}22 45%, transparent 70%)`,
        }}
      />
      <img
        src="/car-top.png"
        alt="vehicle top view"
        width={width}
        height={height}
        className="relative block select-none"
        draggable={false}
        style={{ width, height, objectFit: 'contain', filter: 'drop-shadow(0 8px 16px rgba(8,16,28,0.35))' }}
      />
    </div>
  )
}
