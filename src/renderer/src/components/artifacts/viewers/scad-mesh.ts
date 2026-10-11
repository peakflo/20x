export interface ScadMesh {
  positions: Float32Array
  normals: Float32Array
  triangles: number
}

const MAX_TRIANGLES = 500_000
const NUMBER = '([+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[eE][+-]?\\d+)?)'
const VERTEX = new RegExp(`^\\s*vertex\\s+${NUMBER}\\s+${NUMBER}\\s+${NUMBER}\\s*$`, 'gim')

/** Read an OpenSCAD STL and put Z up in the viewer. The mesh stays local. */
export function parseScadStl(bytes: Uint8Array): ScadMesh {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const count = bytes.byteLength >= 84 ? view.getUint32(80, true) : 0
  if (count > MAX_TRIANGLES && 84 + count * 50 === bytes.byteLength) throw new Error('The 3D model is too detailed to show.')
  const binary = count > 0 && count <= MAX_TRIANGLES && 84 + count * 50 === bytes.byteLength
  let positions: Float32Array

  if (binary) {
    positions = new Float32Array(count * 9)
    for (let triangle = 0; triangle < count; triangle++) {
      const start = 84 + triangle * 50 + 12
      for (let vertex = 0; vertex < 3; vertex++) {
        const offset = start + vertex * 12
        const target = triangle * 9 + vertex * 3
        positions[target] = view.getFloat32(offset, true)
        positions[target + 1] = view.getFloat32(offset + 8, true)
        positions[target + 2] = -view.getFloat32(offset + 4, true)
      }
    }
  } else {
    const source = new TextDecoder().decode(bytes)
    if (!/^\s*solid(?:\s|$)/i.test(source)) throw new Error('OpenSCAD did not return an STL model.')
    const vertices: number[] = []
    for (const match of source.matchAll(VERTEX)) {
      vertices.push(Number(match[1]), Number(match[3]), -Number(match[2]))
      if (vertices.length > MAX_TRIANGLES * 9) throw new Error('The 3D model is too detailed to show.')
    }
    positions = new Float32Array(vertices)
  }

  if (!positions.length || positions.length % 9 !== 0) throw new Error('OpenSCAD did not return a valid 3D model.')
  const min = [Infinity, Infinity, Infinity]
  const max = [-Infinity, -Infinity, -Infinity]
  for (let index = 0; index < positions.length; index += 3) {
    for (let axis = 0; axis < 3; axis++) {
      const value = positions[index + axis]
      if (!Number.isFinite(value)) throw new Error('The 3D model has invalid coordinates.')
      min[axis] = Math.min(min[axis], value)
      max[axis] = Math.max(max[axis], value)
    }
  }
  const extent = Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2]) || 1
  for (let index = 0; index < positions.length; index += 3) {
    for (let axis = 0; axis < 3; axis++) {
      positions[index + axis] = (positions[index + axis] - (min[axis] + max[axis]) / 2) * 1.6 / extent
    }
  }

  const normals = new Float32Array(positions.length)
  for (let index = 0; index < positions.length; index += 9) {
    const ax = positions[index], ay = positions[index + 1], az = positions[index + 2]
    const bx = positions[index + 3], by = positions[index + 4], bz = positions[index + 5]
    const cx = positions[index + 6], cy = positions[index + 7], cz = positions[index + 8]
    const ux = bx - ax, uy = by - ay, uz = bz - az
    const vx = cx - ax, vy = cy - ay, vz = cz - az
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx
    const length = Math.hypot(nx, ny, nz) || 1
    for (let vertex = 0; vertex < 3; vertex++) {
      normals[index + vertex * 3] = nx / length
      normals[index + vertex * 3 + 1] = ny / length
      normals[index + vertex * 3 + 2] = nz / length
    }
  }
  return { positions, normals, triangles: positions.length / 9 }
}
