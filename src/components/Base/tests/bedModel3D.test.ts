import * as THREE from 'three'
import { describe, expect, it, vi } from 'vitest'
import { PILLOW, SIDE_Z, createBedModel, to3 } from '../bedModel3D'
import type { SideState } from '../bedModel3D'
import { DARK_PALETTE } from '../bedLook'

const state = (head: number, feet: number, moving = false, target = { head, feet }): SideState => ({ pose: { head, feet }, target, moving })
const meshes = (root: THREE.Object3D) => {
  const found: THREE.Mesh[] = []
  root.traverse(node => node instanceof THREE.Mesh && found.push(node))
  return found
}
const panelMeshes = (root: THREE.Object3D) => meshes(root).filter(m => Array.isArray(m.material) && (m.material[0] as THREE.MeshStandardMaterial).color.getHexString() === new THREE.Color(DARK_PALETTE.deck).getHexString())

describe('3D bed model', () => {
  it('maps profile units onto the scene', () => {
    expect(to3({ x: 300, y: 196 })).toEqual({ x: 0, y: 0 })
    expect(to3({ x: 560, y: 96 })).toEqual({ x: 2.6, y: 1 })
  })

  it('builds four bevelled panels per half, centred 1.22 either side of the seam', () => {
    const model = createBedModel(THREE, ['left', 'right'])
    model.update({ left: state(0, 0), right: state(0, 0) }, 'base')
    const panels = panelMeshes(model.root)
    expect(panels).toHaveLength(8)
    const box = new THREE.Box3()
    const left = panels.slice(0, 4).map(p => box.setFromBufferAttribute(p.geometry.getAttribute('position') as THREE.BufferAttribute).clone())
    expect(Math.min(...left.map(b => b.min.x))).toBeCloseTo(-2.6, 1)
    expect(Math.max(...left.map(b => b.max.x))).toBeCloseTo(2.6, 1)
    expect(Math.min(...left.map(b => b.min.z))).toBeCloseTo(SIDE_Z.left - 1.2, 3)
    expect(Math.max(...left.map(b => b.max.z))).toBeCloseTo(SIDE_Z.left + 1.2, 3)
    expect(Math.min(...left.map(b => b.min.y))).toBeCloseTo(0, 3)
    expect(Math.max(...left.map(b => b.max.y))).toBeCloseTo(0.18, 3)
    model.dispose()
  })

  it('raises the head panel and keeps outward-facing normals', () => {
    const model = createBedModel(THREE, ['left'])
    model.update({ left: state(45, 0) }, 'base')
    const head = panelMeshes(model.root)[0]
    head.geometry.computeBoundingBox()
    expect(head.geometry.boundingBox?.max.y).toBeGreaterThan(1.4)
    // Bending must keep triangles wound to match their rotated normals.
    const normal = head.geometry.getAttribute('normal')
    const position = head.geometry.getAttribute('position')
    // Welded for smooth shading, so triangles come from the index.
    const index = head.geometry.getIndex()
    if (!index) throw new Error('expected a welded, indexed panel')
    let agree = 0
    let total = 0
    const [a, b, c, n] = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()]
    for (let i = 0; i < index.count; i += 3) {
      a.fromBufferAttribute(position, index.getX(i))
      b.fromBufferAttribute(position, index.getX(i + 1)).sub(a)
      c.fromBufferAttribute(position, index.getX(i + 2)).sub(a)
      const face = b.cross(c)
      if (face.lengthSq() < 1e-12) continue
      n.fromBufferAttribute(normal, index.getX(i))
      total++
      if (face.dot(n) > 0) agree++
    }
    expect(agree / total).toBeGreaterThan(0.95)
    model.dispose()
  })

  it('rebuilds only when an angle moves by at least 0.1°', () => {
    const model = createBedModel(THREE, ['left'])
    expect(model.update({ left: state(10, 5) }, 'base')).toBe(true)
    expect(model.update({ left: state(10.05, 5) }, 'base')).toBe(false)
    expect(model.update({ left: state(10.2, 5) }, 'base')).toBe(true)
    model.dispose()
  })

  it('draws a translucent target ghost only while moving, disposing the old one', () => {
    const model = createBedModel(THREE, ['left'])
    const ghosts = () => meshes(model.root).filter(m => !Array.isArray(m.material) && m.material.transparent)
    model.update({ left: state(0, 0) }, 'base')
    expect(ghosts()).toHaveLength(0)
    model.update({ left: state(0, 0, true, { head: 30, feet: 10 }) }, 'base')
    const [ghost] = ghosts()
    const material = ghost.material as THREE.MeshStandardMaterial
    expect([material.opacity, material.transparent, material.depthWrite]).toEqual([0.18, true, false])
    expect(material.color.getHexString()).toBe(new THREE.Color(DARK_PALETTE.ghostLeft).getHexString())
    const dispose = vi.spyOn(ghost.geometry, 'dispose')
    model.update({ left: state(0, 0, true, { head: 40, feet: 10 }) }, 'base')
    expect(dispose).toHaveBeenCalled()
    expect(ghosts()).toHaveLength(1)
    model.update({ left: state(40, 10) }, 'base')
    expect(ghosts()).toHaveLength(0)
    model.dispose()
  })

  it('adds a mattress and pillow in mattress mode and hides the control box', () => {
    const model = createBedModel(THREE, ['left', 'right'])
    const box = () => meshes(model.root).find(m => m.geometry instanceof THREE.BoxGeometry && (m.geometry.parameters as { height: number }).height === 0.03) as THREE.Mesh
    model.update({ left: state(0, 0), right: state(0, 0) }, 'base')
    const extrusions = () => meshes(model.root).filter(m => m.geometry instanceof THREE.ExtrudeGeometry && m.visible).length
    expect(box().visible).toBe(true)
    const before = extrusions()
    expect(model.update({ left: state(0, 0), right: state(0, 0) }, 'mattress')).toBe(true)
    expect(box().visible).toBe(false)
    // One mattress slab per half; the pillows are cushions, not extrusions.
    expect(extrusions()).toBe(before + 2)
    expect(meshes(model.root).filter(m => m.geometry instanceof THREE.BoxGeometry && m.visible && (m.geometry.parameters as { height: number }).height === PILLOW.height)).toHaveLength(2)
    model.update({ left: state(0, 0), right: state(0, 0) }, 'base')
    expect(extrusions()).toBe(before)
    model.dispose()
  })

  it('leaves the pillows out when asked', () => {
    const model = createBedModel(THREE, ['left', 'right'], { pillows: false })
    model.update({ left: state(0, 0), right: state(0, 0) }, 'mattress')
    expect(meshes(model.root).filter(m => m.geometry instanceof THREE.BoxGeometry && (m.geometry.parameters as { height: number }).height === PILLOW.height)).toHaveLength(0)
    model.dispose()
  })

  it('disposes every geometry and material', () => {
    const model = createBedModel(THREE, ['left', 'right'])
    model.update({ left: state(20, 10, true, { head: 0, feet: 0 }), right: state(0, 0) }, 'mattress')
    const disposals = meshes(model.root).flatMap(m => [m.geometry, ...[m.material].flat()]).map(item => vi.spyOn(item, 'dispose'))
    model.dispose()
    expect(disposals.every(spy => spy.mock.calls.length > 0)).toBe(true)
    expect(model.geometryCount()).toBe(0)
    expect(model.root.children).toHaveLength(0)
  })
})
