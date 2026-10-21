// The reel's per-segment motion (make-reel.mjs). Pure strings, so the tests can read the filter graph.
/** Ken Burns move per segment: alternate zoom direction and drift axis so it never loops. */
export const MOVES = [
  { zoom: 'in', x: 'centre', y: 'centre' },
  { zoom: 'out', x: 'centre', y: 'down' },
  { zoom: 'in', x: 'right', y: 'centre' },
  { zoom: 'out', x: 'left', y: 'centre' },
  { zoom: 'in', x: 'centre', y: 'up' },
  { zoom: 'out', x: 'right', y: 'down' },
  { zoom: 'in', x: 'left', y: 'up' },
];

/**
 * zoompan expressions for one segment.
 * `on` is the output frame index inside this segment, so every expression is a pure
 * function of time — no dependence on the previous frame's zoom, which is what makes
 * zoompan drift and stutter.
 */
export function kenBurns(move, frames, { amount = 0.16 } = {}) {
  const n = Math.max(1, frames - 1);
  const p = `(on/${n})`;
  const z = move.zoom === 'in'
    ? `min(${(1 + amount).toFixed(4)},1+${amount.toFixed(4)}*${p})`
    : `max(1,${(1 + amount).toFixed(4)}-${amount.toFixed(4)}*${p})`;
  const span = (dim) => `(i${dim}-i${dim}/zoom)`;
  const axis = (kind, dim) => (
    kind === 'centre' ? `${span(dim)}/2`
      : kind === 'right' || kind === 'down' ? `${span(dim)}*(0.15+0.7*${p})`
        : `${span(dim)}*(0.85-0.7*${p})`
  );
  return { z, x: axis(move.x, 'w'), y: axis(move.y, 'h') };
}

/**
 * The ffmpeg -vf chain for one photo segment. `still: true` (padded 4:5 frames and plot cards,
 * --fit pad): no zoom and no pan, so the frame stays whole on its 9:16 canvas, edge to edge;
 * otherwise the Ken Burns move for this segment over a cover-cropped still.
 */
export function segmentFilter({ W, H, SS, FPS, index, frames, still = false }) {
  const kb = still ? { z: '1', x: '0', y: '0' } : kenBurns(MOVES[index % MOVES.length], frames);
  return [
    `scale=${W * SS}:${H * SS}:force_original_aspect_ratio=increase`,
    `crop=${W * SS}:${H * SS}`,
    `zoompan=z='${kb.z}':x='${kb.x}':y='${kb.y}':d=1:s=${W}x${H}:fps=${FPS}`,
    'setsar=1',
    'format=yuv420p',
  ].join(',');
}
