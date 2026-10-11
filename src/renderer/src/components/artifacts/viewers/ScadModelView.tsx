import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js'

/** Show an STL from the local OpenSCAD render. Drag to turn; scroll to zoom. */
export function ScadModelView({ stl }: { stl: string }) {
  const host = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const element = host.current
    if (!element) return
    const bytes = Uint8Array.from(atob(stl), (character) => character.charCodeAt(0))
    const geometry = new STLLoader().parse(bytes.buffer)
    geometry.computeBoundingBox()
    const box = geometry.boundingBox!
    const center = box.getCenter(new THREE.Vector3())
    geometry.translate(-center.x, -center.y, -center.z)
    geometry.computeVertexNormals()
    const size = box.getSize(new THREE.Vector3())
    const extent = Math.max(size.x, size.y, size.z, 1)

    const scene = new THREE.Scene()
    scene.background = new THREE.Color('#0d1117')
    const camera = new THREE.PerspectiveCamera(45, 1, extent / 1000, extent * 100)
    camera.up.set(0, 0, 1)
    camera.position.set(extent * 1.5, -extent * 1.7, extent * 1.3)
    camera.lookAt(0, 0, 0)
    const material = new THREE.MeshStandardMaterial({ color: '#82b8f5', metalness: 0.08, roughness: 0.68, side: THREE.DoubleSide })
    scene.add(new THREE.Mesh(geometry, material))
    scene.add(new THREE.AmbientLight(0xffffff, 2))
    const light = new THREE.DirectionalLight(0xffffff, 2.2)
    light.position.set(extent, extent * 2, extent)
    scene.add(light)
    const renderer = new THREE.WebGLRenderer({ antialias: true })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
    element.appendChild(renderer.domElement)
    const controls = new OrbitControls(camera, renderer.domElement)
    controls.enableDamping = true
    const resize = new ResizeObserver(() => {
      const width = element.clientWidth || 1
      const height = element.clientHeight || 1
      camera.aspect = width / height
      camera.updateProjectionMatrix()
      renderer.setSize(width, height)
    })
    resize.observe(element)
    let frame = 0
    const draw = () => {
      frame = requestAnimationFrame(draw)
      controls.update()
      renderer.render(scene, camera)
    }
    draw()
    return () => {
      cancelAnimationFrame(frame)
      resize.disconnect()
      controls.dispose()
      geometry.dispose()
      material.dispose()
      renderer.dispose()
      element.removeChild(renderer.domElement)
    }
  }, [stl])

  return <div ref={host} aria-label="3D SCAD preview" className="h-full min-h-[240px] w-full" />
}
