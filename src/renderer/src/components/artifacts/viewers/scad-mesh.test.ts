import { describe, expect, it } from 'vitest'
import { parseScadStl } from './scad-mesh'

describe('OpenSCAD STL mesh', () => {
  it('reads ASCII STL and puts the model at the center', () => {
    const bytes = new TextEncoder().encode('solid case\n facet normal 0 0 1\n outer loop\n vertex 0 0 0\n vertex 2 0 0\n vertex 0 2 0\n endloop\n endfacet\nendsolid case\n')
    const mesh = parseScadStl(bytes)
    expect(mesh.triangles).toBe(1)
    const expected = [-0.8, 0, 0.8, 0.8, 0, 0.8, -0.8, 0, -0.8]
    expected.forEach((value, index) => expect(mesh.positions[index]).toBeCloseTo(value))
    expect(mesh.normals.length).toBe(9)
  })

  it('reads binary STL from OpenSCAD', () => {
    const bytes = new Uint8Array(134)
    const view = new DataView(bytes.buffer)
    view.setUint32(80, 1, true)
    const coordinates = [0, 0, 0, 1, 0, 0, 0, 1, 0]
    coordinates.forEach((value, index) => view.setFloat32(96 + index * 4, value, true))
    const mesh = parseScadStl(bytes)
    expect(mesh.triangles).toBe(1)
    expect(mesh.positions.length).toBe(9)
    expect([...mesh.normals].every(Number.isFinite)).toBe(true)
  })

  it('rejects invalid model data', () => {
    expect(() => parseScadStl(new TextEncoder().encode('not an STL'))).toThrow('STL model')
  })
})
