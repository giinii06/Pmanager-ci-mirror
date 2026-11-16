/**
 * Reads a stored vector without copying when the blob is aligned and holds
 * exactly one vector. A misaligned or oversized blob is copied so the view can
 * never read past the row.
 */
export function asFloats(bytes: Uint8Array, dimensions: number): Float32Array {
  if (bytes.byteOffset % 4 === 0 && bytes.byteLength === dimensions * 4) {
    return new Float32Array(bytes.buffer, bytes.byteOffset, dimensions)
  }
  return new Float32Array(bytes.slice().buffer)
}
