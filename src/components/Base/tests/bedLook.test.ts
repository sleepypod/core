import * as THREE from 'three'
import { describe, expect, it, vi } from 'vitest'
import type { Three } from '../loadThree'
import { DAY_ROOM, NIGHT_ROOM, ROOM, roomBackdrop } from '../bedLook'

const renderer = () => ({ setClearColor: vi.fn() }) as unknown as THREE.WebGLRenderer

describe('room backdrop', () => {
  it('stands the wall squarely behind the bed for the current azimuth', () => {
    const scene = new THREE.Scene()
    const room = roomBackdrop(THREE as unknown as Three, scene, renderer(), false, -0.5)
    const wall = room.group.children.find(child => (child as THREE.Mesh).geometry instanceof THREE.PlaneGeometry && child.rotation.x === 0) as THREE.Mesh
    room.follow(0, 0)
    expect(wall.position.x).toBeCloseTo(-ROOM.wallDistance)
    expect(wall.position.z).toBeCloseTo(0)
    // Its normal points back at a camera sitting on +x.
    const normal = new THREE.Vector3(0, 0, 1).applyEuler(wall.rotation)
    expect(normal.x).toBeCloseTo(1)
    room.follow(Math.PI / 2, 1.2)
    expect(wall.position.x).toBeCloseTo(0)
    expect(wall.position.z).toBeCloseTo(1.2 - ROOM.wallDistance)
    expect(new THREE.Vector3(0, 0, 1).applyEuler(wall.rotation).z).toBeCloseTo(1)
    // The wall's base sits on the floor.
    expect(wall.position.y).toBeCloseTo(-0.5 + ROOM.wallHeight / 2)
    room.dispose()
  })
  it('paints night or day, clears the canvas to the haze and leaves no fog behind', () => {
    const scene = new THREE.Scene()
    const gl = renderer()
    const room = roomBackdrop(THREE as unknown as Three, scene, gl, true, 0)
    expect(scene.fog).toBeInstanceOf(THREE.Fog)
    expect((scene.fog as THREE.Fog).color.getHexString()).toBe(DAY_ROOM.haze.slice(1))
    expect(gl.setClearColor).toHaveBeenLastCalledWith(DAY_ROOM.haze, 1)
    room.recolor(false)
    expect((scene.fog as THREE.Fog).color.getHexString()).toBe(NIGHT_ROOM.haze.slice(1))
    expect(gl.setClearColor).toHaveBeenLastCalledWith(NIGHT_ROOM.haze, 1)
    const materials = room.group.children.map(child => (child as THREE.Mesh).material as THREE.MeshBasicMaterial)
    expect(materials.map(m => m.color.getHexString())).toEqual([NIGHT_ROOM.floor, NIGHT_ROOM.wall, NIGHT_ROOM.pool].map(hex => hex.slice(1)))
    expect(materials[2].opacity).toBe(NIGHT_ROOM.poolOpacity)
    const disposed = materials.map(m => vi.spyOn(m, 'dispose'))
    room.dispose()
    expect(scene.fog).toBeNull()
    expect(scene.children).not.toContain(room.group)
    disposed.forEach(spy => expect(spy).toHaveBeenCalledOnce())
  })
})
