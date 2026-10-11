import { useEffect, useRef, useState } from 'react'
import { parseScadStl } from './scad-mesh'

const VERTEX_SHADER = `
attribute vec3 aPosition;
attribute vec3 aNormal;
uniform float uYaw;
uniform float uPitch;
uniform float uZoom;
uniform float uAspect;
varying float vShade;
vec3 turn(vec3 point) {
  float cy = cos(uYaw), sy = sin(uYaw);
  point = vec3(cy * point.x + sy * point.z, point.y, -sy * point.x + cy * point.z);
  float cx = cos(uPitch), sx = sin(uPitch);
  return vec3(point.x, cx * point.y - sx * point.z, sx * point.y + cx * point.z);
}
void main() {
  vec3 point = turn(aPosition);
  vec3 normal = normalize(turn(aNormal));
  float depth = uZoom - point.z;
  gl_Position = vec4(point.x * 2.2 / uAspect, point.y * 2.2, depth - 0.2, depth);
  vShade = 0.38 + 0.62 * abs(dot(normal, normalize(vec3(0.35, 0.75, 0.65))));
}`

const FRAGMENT_SHADER = `
precision mediump float;
varying float vShade;
void main() {
  gl_FragColor = vec4(vec3(0.51, 0.72, 0.96) * vShade, 1.0);
}`

function makeShader(gl: WebGLRenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type)
  if (!shader) throw new Error('The 3D view could not start.')
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const message = gl.getShaderInfoLog(shader) || 'Shader error'
    gl.deleteShader(shader)
    throw new Error(message)
  }
  return shader
}

/** Show an STL with the browser WebGL API. Drag to turn; scroll to zoom. */
export function ScadModelView({ stl }: { stl: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    let gl: WebGLRenderingContext | null = null
    let program: WebGLProgram | null = null
    let positionBuffer: WebGLBuffer | null = null
    let normalBuffer: WebGLBuffer | null = null
    let resize: ResizeObserver | null = null
    let frame = 0
    let pointer: { x: number; y: number; id: number } | null = null
    let yaw = -0.65
    let pitch = 0.4
    let zoom = 2.7
    let removeEvents = () => {}

    try {
      const bytes = Uint8Array.from(atob(stl), (character) => character.charCodeAt(0))
      const mesh = parseScadStl(bytes)
      gl = canvas.getContext('webgl', { antialias: true, alpha: true })
      if (!gl) throw new Error('This device cannot show a WebGL 3D view.')
      const vertex = makeShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER)
      const fragment = makeShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER)
      program = gl.createProgram()
      if (!program) throw new Error('The 3D view could not start.')
      gl.attachShader(program, vertex)
      gl.attachShader(program, fragment)
      gl.linkProgram(program)
      gl.deleteShader(vertex)
      gl.deleteShader(fragment)
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) || 'The 3D view could not start.')
      gl.useProgram(program)

      positionBuffer = gl.createBuffer()
      normalBuffer = gl.createBuffer()
      if (!positionBuffer || !normalBuffer) throw new Error('The 3D view has no graphics memory.')
      const positionLocation = gl.getAttribLocation(program, 'aPosition')
      const normalLocation = gl.getAttribLocation(program, 'aNormal')
      gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer)
      gl.bufferData(gl.ARRAY_BUFFER, mesh.positions, gl.STATIC_DRAW)
      gl.enableVertexAttribArray(positionLocation)
      gl.vertexAttribPointer(positionLocation, 3, gl.FLOAT, false, 0, 0)
      gl.bindBuffer(gl.ARRAY_BUFFER, normalBuffer)
      gl.bufferData(gl.ARRAY_BUFFER, mesh.normals, gl.STATIC_DRAW)
      gl.enableVertexAttribArray(normalLocation)
      gl.vertexAttribPointer(normalLocation, 3, gl.FLOAT, false, 0, 0)
      const yawLocation = gl.getUniformLocation(program, 'uYaw')
      const pitchLocation = gl.getUniformLocation(program, 'uPitch')
      const zoomLocation = gl.getUniformLocation(program, 'uZoom')
      const aspectLocation = gl.getUniformLocation(program, 'uAspect')
      gl.enable(gl.DEPTH_TEST)
      // Let the canvas CSS background follow the chat theme without rebuilding the model.
      gl.clearColor(0, 0, 0, 0)

      const draw = () => {
        frame = 0
        if (!gl) return
        gl.viewport(0, 0, canvas.width, canvas.height)
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT)
        gl.uniform1f(yawLocation, yaw)
        gl.uniform1f(pitchLocation, pitch)
        gl.uniform1f(zoomLocation, zoom)
        gl.uniform1f(aspectLocation, canvas.width / Math.max(canvas.height, 1))
        gl.drawArrays(gl.TRIANGLES, 0, mesh.positions.length / 3)
      }
      const requestDraw = () => { if (!frame) frame = requestAnimationFrame(draw) }
      const onPointerDown = (event: PointerEvent) => {
        pointer = { x: event.clientX, y: event.clientY, id: event.pointerId }
        canvas.setPointerCapture(event.pointerId)
      }
      const onPointerMove = (event: PointerEvent) => {
        if (!pointer || event.pointerId !== pointer.id) return
        yaw += (event.clientX - pointer.x) * 0.01
        pitch = Math.max(-1.45, Math.min(1.45, pitch + (event.clientY - pointer.y) * 0.01))
        pointer = { x: event.clientX, y: event.clientY, id: event.pointerId }
        requestDraw()
      }
      const onPointerUp = (event: PointerEvent) => {
        if (pointer?.id === event.pointerId) pointer = null
      }
      const onWheel = (event: WheelEvent) => {
        event.preventDefault()
        zoom = Math.max(1.4, Math.min(8, zoom * Math.exp(event.deltaY * 0.001)))
        requestDraw()
      }
      canvas.addEventListener('pointerdown', onPointerDown)
      canvas.addEventListener('pointermove', onPointerMove)
      canvas.addEventListener('pointerup', onPointerUp)
      canvas.addEventListener('pointercancel', onPointerUp)
      canvas.addEventListener('wheel', onWheel, { passive: false })
      removeEvents = () => {
        canvas.removeEventListener('pointerdown', onPointerDown)
        canvas.removeEventListener('pointermove', onPointerMove)
        canvas.removeEventListener('pointerup', onPointerUp)
        canvas.removeEventListener('pointercancel', onPointerUp)
        canvas.removeEventListener('wheel', onWheel)
      }
      resize = new ResizeObserver(() => {
        const scale = Math.min(window.devicePixelRatio || 1, 2)
        canvas.width = Math.max(1, Math.round(canvas.clientWidth * scale))
        canvas.height = Math.max(1, Math.round(canvas.clientHeight * scale))
        requestDraw()
      })
      resize.observe(canvas)
      requestDraw()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    }

    return () => {
      if (frame) cancelAnimationFrame(frame)
      resize?.disconnect()
      removeEvents()
      if (gl) {
        if (positionBuffer) gl.deleteBuffer(positionBuffer)
        if (normalBuffer) gl.deleteBuffer(normalBuffer)
        if (program) gl.deleteProgram(program)
      }
    }
  }, [stl])

  return <div className="relative h-full min-h-0 w-full">
    <canvas ref={canvasRef} aria-label="3D SCAD preview" className="h-full w-full touch-none bg-background" />
    {error && <div role="alert" className="absolute inset-0 flex items-center justify-center bg-background p-4 text-center text-xs text-red-400">{error}</div>}
  </div>
}
