import type { ReactElement } from 'react'
import type { PeakoMood } from '@shared/peako'

// Coordinates follow the 20x logo (src/renderer/src/assets/logos/20x.svg):
// a rounded square with an eye at each of these centres.
const LEFT: [number, number] = [163, 153]
const RIGHT: [number, number] = [237, 153]

type Eye = (centre: [number, number], side: 1 | -1) => ReactElement

const crossEye: Eye = ([cx, cy]) => (
  <path className="peako-stroke" d={`M${cx - 15} ${cy - 15} L${cx + 15} ${cy + 15} M${cx + 15} ${cy - 15} L${cx - 15} ${cy + 15}`} />
)
const dotEye = (r: number): Eye => ([cx, cy]) => <circle className="peako-fill" cx={cx} cy={cy} r={r} />
const lookUpEye: Eye = ([cx, cy]) => <circle className="peako-fill" cx={cx + 4} cy={cy - 8} r={11} />
const happyEye: Eye = ([cx, cy]) => <path className="peako-stroke" d={`M${cx - 16} ${cy + 6} Q${cx} ${cy - 18} ${cx + 16} ${cy + 6}`} />
const shutEye: Eye = ([cx, cy]) => <path className="peako-stroke" d={`M${cx - 16} ${cy} Q${cx} ${cy + 12} ${cx + 16} ${cy}`} />
const squintEye: Eye = ([cx, cy], side) => (
  <path className="peako-stroke" d={`M${cx - 14 * side} ${cy - 13} L${cx + 14 * side} ${cy} L${cx - 14 * side} ${cy + 13}`} />
)
const barsEye: Eye = ([cx, cy]) => (
  <>
    {[-12, 0, 12].map((offset, i) => (
      <rect
        key={offset}
        className="peako-fill peako-bar"
        style={{ animationDelay: `${i * 0.15}s` }}
        x={cx + offset - 3.5}
        y={cy - 16}
        width={7}
        height={32}
        rx={3.5}
      />
    ))}
  </>
)

const FACES: Record<PeakoMood, { eye: Eye; mouth?: string }> = {
  idle: { eye: crossEye },
  working: { eye: dotEye(11) },
  thinking: { eye: lookUpEye },
  needs: { eye: dotEye(15), mouth: 'M192 202 a8 8 0 1 0 16 0 a8 8 0 1 0 -16 0' },
  party: { eye: happyEye, mouth: 'M180 192 Q200 214 220 192' },
  stuck: { eye: squintEye, mouth: 'M184 206 Q200 194 216 206' },
  listening: { eye: barsEye },
  speaking: { eye: happyEye, mouth: 'M186 196 Q200 212 214 196 Z' },
  sleep: { eye: shutEye }
}

export function PeakoFace({ mood }: { mood: PeakoMood }) {
  const face = FACES[mood]
  return (
    <svg className="peako-svg" viewBox="92 72 216 181" aria-hidden="true">
      <rect className="peako-body-rect" x="100" y="80" width="200" height="165" rx="34" ry="34" />
      <g className="peako-eyes" key={mood}>
        {face.eye(LEFT, 1)}
        {face.eye(RIGHT, -1)}
        {face.mouth && <path className={`peako-stroke peako-mouth${mood === 'speaking' ? ' peako-talk' : ''}`} d={face.mouth} />}
      </g>
    </svg>
  )
}

export const MOOD_LABELS: Record<PeakoMood, string> = {
  idle: 'All quiet',
  working: 'Agents are working',
  thinking: 'Thinking',
  needs: 'Needs you',
  party: 'Something finished',
  stuck: 'Something failed',
  listening: 'Listening',
  speaking: 'Speaking',
  sleep: 'Dozing'
}
