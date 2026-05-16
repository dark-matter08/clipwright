// Pure timeline mutations.
//
// Every editor operation (split / delete / duplicate / merge / reorder) is
// expressed as a pure function `(Video, ...args) -> Video`. The store
// composes these and persists via `saveVideo()`. Same shape, no
// surprises — keeping mutations pure means undo/redo is "just" snapshot
// rotation.
//
// Segment ID invariants per SRS §5.9:
//   - never reuse an existing id
//   - splitting yields the original id + a new id; downstream ids are not
//     renumbered

import type { Segment, SegmentRef, Video } from "./types";

const ID_PATTERN = /^seg_(\d+)([a-z]*)$/;
const NUMERIC_PATTERN = /^seg_(\d+)$/;

/** Generate the next `seg_NNN` id given existing ids. Mirrors Python's
 *  `clipwright.schema.v1.timeline.next_segment_id`. */
export function nextSegmentId(existing: readonly string[]): string {
  let n = 0;
  for (const sid of existing) {
    const m = NUMERIC_PATTERN.exec(sid);
    if (m) n = Math.max(n, parseInt(m[1]!, 10));
  }
  return `seg_${String(n + 1).padStart(3, "0")}`;
}

/** Generate a `seg_NNNa`, `seg_NNNb`… suffix variant. Used when splitting,
 *  so the original numeric prefix stays anchored. */
export function nextSuffixedId(base: string, existing: readonly string[]): string {
  const m = ID_PATTERN.exec(base);
  const numericPrefix = m ? m[1]! : base.replace(/^seg_/, "");
  // start from "a" and grow
  const used = new Set(existing);
  for (let i = 0; i < 26; i++) {
    const candidate = `seg_${numericPrefix}${String.fromCharCode(97 + i)}`;
    if (!used.has(candidate)) return candidate;
  }
  return nextSegmentId(existing); // pathological fallback
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

function rebuildRef(ref: SegmentRef, oldId: string, newId: string): SegmentRef {
  if (!ref.ref) return ref;
  return { ...ref, ref: ref.ref.replace(`#${oldId}`, `#${newId}`) };
}

/** Split a segment in half (at midpoint, in P1.4). The new segment inherits
 *  the original's properties; both pieces get unique ids. Per-segment refs
 *  are rewritten to point at the new ids. */
export function splitSegment(tl: Video, segId: string): Video {
  const idx = tl.segments.findIndex((s) => s.id === segId);
  if (idx < 0) return tl;
  const seg = tl.segments[idx]!;
  const midpoint = (seg.source_start + seg.source_end) / 2;
  const ids = tl.segments.map((s) => s.id);

  const left = clone(seg);
  left.source_end = midpoint;
  left.target_duration = midpoint - left.source_start;
  left.captions = rebuildRef(left.captions, seg.id, left.id);
  left.camera = rebuildRef(left.camera, seg.id, left.id);
  left.annotations = rebuildRef(left.annotations, seg.id, left.id);

  const right = clone(seg);
  right.id = nextSuffixedId(seg.id, ids);
  right.source_start = midpoint;
  right.target_duration = seg.source_end - midpoint;
  // Clear the right side's VO binding — a split should not point both
  // halves at the same script clip.
  right.voiceover = { enabled: right.voiceover.enabled, script_clip_id: "" };
  right.captions = rebuildRef(right.captions, seg.id, right.id);
  right.camera = rebuildRef(right.camera, seg.id, right.id);
  right.annotations = rebuildRef(right.annotations, seg.id, right.id);

  const next = clone(tl);
  next.segments.splice(idx, 1, left, right);
  return next;
}

/** Drop a segment from the timeline. */
export function deleteSegment(tl: Video, segId: string): Video {
  const next = clone(tl);
  next.segments = next.segments.filter((s) => s.id !== segId);
  return next;
}

/** Duplicate a segment in place. The clone gets a fresh id; its refs are
 *  rewritten to point at the new id. */
export function duplicateSegment(tl: Video, segId: string): Video {
  const idx = tl.segments.findIndex((s) => s.id === segId);
  if (idx < 0) return tl;
  const seg = tl.segments[idx]!;
  const ids = tl.segments.map((s) => s.id);
  const newId = nextSegmentId(ids);

  const dup = clone(seg);
  dup.id = newId;
  dup.captions = rebuildRef(dup.captions, seg.id, newId);
  dup.camera = rebuildRef(dup.camera, seg.id, newId);
  dup.annotations = rebuildRef(dup.annotations, seg.id, newId);
  // Clear VO clip binding — the duplicate should produce its own script
  // clip via a regenerate flow, not double-spend on the original's audio.
  dup.voiceover = { enabled: dup.voiceover.enabled, script_clip_id: "" };

  const next = clone(tl);
  next.segments.splice(idx + 1, 0, dup);
  return next;
}

/** Merge a segment with the one before or after it. The neighbor's
 *  source range is absorbed; the neighbor is dropped from the timeline.
 *  The merged segment keeps the focused segment's id and properties. */
export function mergeSegment(
  tl: Video,
  segId: string,
  direction: "prev" | "next",
): Video {
  const idx = tl.segments.findIndex((s) => s.id === segId);
  if (idx < 0) return tl;
  const neighborIdx = direction === "prev" ? idx - 1 : idx + 1;
  if (neighborIdx < 0 || neighborIdx >= tl.segments.length) return tl;

  const seg = tl.segments[idx]!;
  const neighbor = tl.segments[neighborIdx]!;
  const merged = clone(seg);
  merged.source_start = Math.min(seg.source_start, neighbor.source_start);
  merged.source_end = Math.max(seg.source_end, neighbor.source_end);
  merged.target_duration = merged.source_end - merged.source_start;

  const next = clone(tl);
  const lo = Math.min(idx, neighborIdx);
  next.segments.splice(lo, 2, merged);
  return next;
}

/** Move a segment forward/back by one position. */
export function moveSegment(
  tl: Video,
  segId: string,
  direction: "prev" | "next",
): Video {
  const idx = tl.segments.findIndex((s) => s.id === segId);
  if (idx < 0) return tl;
  const target = direction === "prev" ? idx - 1 : idx + 1;
  if (target < 0 || target >= tl.segments.length) return tl;
  const next = clone(tl);
  const [moved] = next.segments.splice(idx, 1);
  next.segments.splice(target, 0, moved!);
  return next;
}

/** Convenience: id of the segment offset from `segId` by N positions.
 *  Used for ←/→ keyboard navigation. */
export function neighborId(
  tl: Video,
  segId: string | null,
  offset: number,
): string | null {
  if (tl.segments.length === 0) return null;
  if (!segId) return tl.segments[0]!.id;
  const idx = tl.segments.findIndex((s) => s.id === segId);
  if (idx < 0) return tl.segments[0]!.id;
  const target = Math.max(0, Math.min(tl.segments.length - 1, idx + offset));
  return tl.segments[target]!.id;
}

export function findSegment(tl: Video, segId: string | null): Segment | null {
  if (!segId) return null;
  return tl.segments.find((s) => s.id === segId) ?? null;
}

// ---------------------------------------------------------------------------
// Video-id helpers (mirror Python's `clipwright.schema.v2.video`)
// ---------------------------------------------------------------------------

const VIDEO_ID_RE = /^[a-z][a-z0-9_-]*$/;

/** Sanitize a user-typed video id to `[a-z][a-z0-9_-]*`.
 *  Lowercases, collapses non-`[a-z0-9_-]` to single hyphens, strips
 *  leading hyphens/underscores. Returns `""` if the result can't start
 *  with a letter (caller falls back to a default). */
export function sanitizeVideoId(s: string): string {
  const lowered = s.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^[-_]+|[-_]+$/g, "");
  if (!lowered || !/^[a-z]/.test(lowered)) return "";
  return lowered;
}

export function isValidVideoId(s: string): boolean {
  return VIDEO_ID_RE.test(s);
}
