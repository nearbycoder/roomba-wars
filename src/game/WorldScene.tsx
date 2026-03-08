import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { useEffect, useLayoutEffect, useRef } from 'react'
import * as THREE from 'three'
import { type VisibleEnemy, type VisiblePlayer, type VisibleTile } from '../../shared/protocol'

let sharedDirtDecalTexture: THREE.Texture | null = null

const INSTANCE_OBJECT = new THREE.Object3D()
const INSTANCE_POSITION = new THREE.Vector3()
const INSTANCE_COLOR = new THREE.Color()
const INSTANCE_SENSOR_OFFSET = new THREE.Vector3()

interface WorldSceneProps {
  self: VisiblePlayer | null
  players: VisiblePlayer[]
  enemies: VisibleEnemy[]
  tiles: VisibleTile[]
  now: number
  cameraMode?: 'follow' | 'spectator' | 'free'
  spectatorView?: 'default' | 'benchmark'
  fillVoidTiles?: boolean
  actorStyle?: 'default' | 'benchmark'
  onFreeCameraFocusChange?:
    | ((view: { camera: { x: number; z: number }; focus: { x: number; z: number } }) => void)
    | undefined
}

export function WorldScene({
  self,
  players,
  enemies,
  tiles,
  now,
  cameraMode = 'follow',
  spectatorView = 'default',
  fillVoidTiles = false,
  actorStyle = 'default',
  onFreeCameraFocusChange,
}: WorldSceneProps) {
  return (
    <Canvas camera={{ position: [0, 7, 10], fov: 55 }}>
      <color attach="background" args={['#bdcdb0']} />
      <fog attach="fog" args={['#bdcdb0', 10, 32]} />
      <ambientLight intensity={0.7} />
      <directionalLight position={[4, 14, 6]} intensity={1.05} castShadow />
      <hemisphereLight args={['#fcf3d0', '#54684f', 0.8]} />
      {cameraMode === 'follow' && self ? <FollowCamera self={self} /> : null}
      {cameraMode === 'spectator' ? <SpectatorCamera view={spectatorView} /> : null}
      {cameraMode === 'free' ? <FreeRoamCamera onFocusChange={onFreeCameraFocusChange} /> : null}
      <Ground />
      <Tiles tiles={tiles} now={now} fillVoidTiles={fillVoidTiles} />
      <Players players={players} selfSessionId={self?.sessionId ?? ''} actorStyle={actorStyle} />
      <DustBunnies enemies={enemies} />
    </Canvas>
  )
}

function FollowCamera({ self }: { self: VisiblePlayer }) {
  const { camera } = useThree()
  const focusTarget = useRef(new THREE.Vector3())
  const desiredFocus = useRef(new THREE.Vector3())
  const lookTarget = useRef(new THREE.Vector3())
  const cameraTarget = useRef(new THREE.Vector3())
  const forward = useRef(new THREE.Vector3())
  const smoothedYaw = useRef(0)
  const initialized = useRef(false)

  useFrame((_, delta) => {
    const targetYaw = headingToRotation(self.heading)

    if (!initialized.current) {
      smoothedYaw.current = targetYaw
      focusTarget.current.set(self.x, 0.85, self.z)
      forward.current.copy(forwardFromYaw(targetYaw))
      lookTarget.current.copy(focusTarget.current).addScaledVector(forward.current, 4)
      cameraTarget.current.copy(focusTarget.current).addScaledVector(forward.current, -6)
      cameraTarget.current.y = 3.4
      camera.position.copy(cameraTarget.current)
      initialized.current = true
    }

    const turnLerp = 1 - Math.exp(-delta * 10)
    const moveLerp = 1 - Math.exp(-delta * 12)
    smoothedYaw.current = dampAngle(smoothedYaw.current, targetYaw, turnLerp)
    desiredFocus.current.set(self.x, 0.85, self.z)
    focusTarget.current.lerp(desiredFocus.current, moveLerp)
    forward.current.copy(forwardFromYaw(smoothedYaw.current))
    lookTarget.current.copy(focusTarget.current).addScaledVector(forward.current, 4)
    cameraTarget.current.copy(focusTarget.current).addScaledVector(forward.current, -6)
    cameraTarget.current.y = 3.4

    camera.position.lerp(cameraTarget.current, moveLerp)
    camera.lookAt(lookTarget.current)
  })

  return null
}

function SpectatorCamera({ view = 'default' }: { view?: 'default' | 'benchmark' }) {
  const { camera } = useThree()
  const lookTarget = useRef(new THREE.Vector3(0, 0.5, 0))
  const cameraTarget = useRef(view === 'benchmark' ? new THREE.Vector3(0, 20, 22) : new THREE.Vector3(0, 9, 10))

  useEffect(() => {
    if (view === 'benchmark') {
      cameraTarget.current.set(0, 20, 22)
      return
    }
    cameraTarget.current.set(0, 9, 10)
  }, [view])

  useFrame(() => {
    camera.position.lerp(cameraTarget.current, 0.08)
    camera.lookAt(lookTarget.current)
  })

  return null
}

function FreeRoamCamera({
  onFocusChange,
}: {
  onFocusChange?: (view: { camera: { x: number; z: number }; focus: { x: number; z: number } }) => void
}) {
  const { camera, gl } = useThree()
  const position = useRef(new THREE.Vector3(0, 12, 18))
  const yaw = useRef(0)
  const pitch = useRef(-0.48)
  const dragging = useRef(false)
  const keys = useRef(new Set<string>())
  const initialized = useRef(false)
  const planarForward = useRef(new THREE.Vector3())
  const planarRight = useRef(new THREE.Vector3())
  const verticalOffset = useRef(new THREE.Vector3())
  const rotationEuler = useRef(new THREE.Euler(0, 0, 0, 'YXZ'))
  const focusPoint = useRef(new THREE.Vector3())
  const viewDirection = useRef(new THREE.Vector3())

  useEffect(() => {
    const element = gl.domElement

    const onMouseDown = (event: MouseEvent) => {
      if (event.button !== 0) {
        return
      }
      dragging.current = true
    }

    const onMouseUp = () => {
      dragging.current = false
    }

    const onMouseMove = (event: MouseEvent) => {
      if (!dragging.current) {
        return
      }

      yaw.current -= event.movementX * 0.004
      pitch.current = clampScalar(pitch.current - event.movementY * 0.003, -1.2, -0.12)
    }

    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      const move = clampScalar(event.deltaY * 0.018, -3, 3)
      planarForward.current.set(-Math.sin(yaw.current), 0, -Math.cos(yaw.current))
      position.current.addScaledVector(planarForward.current, move)
    }

    const onKeyDown = (event: KeyboardEvent) => {
      keys.current.add(event.key.toLowerCase())
    }

    const onKeyUp = (event: KeyboardEvent) => {
      keys.current.delete(event.key.toLowerCase())
    }

    const onBlur = () => {
      keys.current.clear()
      dragging.current = false
    }

    const preventContextMenu = (event: MouseEvent) => event.preventDefault()

    element.addEventListener('mousedown', onMouseDown)
    window.addEventListener('mouseup', onMouseUp)
    window.addEventListener('mousemove', onMouseMove)
    element.addEventListener('wheel', onWheel, { passive: false })
    element.addEventListener('contextmenu', preventContextMenu)
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', onBlur)

    return () => {
      element.removeEventListener('mousedown', onMouseDown)
      window.removeEventListener('mouseup', onMouseUp)
      window.removeEventListener('mousemove', onMouseMove)
      element.removeEventListener('wheel', onWheel)
      element.removeEventListener('contextmenu', preventContextMenu)
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', onBlur)
    }
  }, [gl.domElement])

  useFrame((_, delta) => {
    if (!initialized.current) {
      camera.position.copy(position.current)
      initialized.current = true
    }

    const speed = keys.current.has('shift') ? 20 : 10
    planarForward.current.set(-Math.sin(yaw.current), 0, -Math.cos(yaw.current)).normalize()
    planarRight.current.set(Math.cos(yaw.current), 0, -Math.sin(yaw.current)).normalize()

    if (keys.current.has('w')) {
      position.current.addScaledVector(planarForward.current, speed * delta)
    }
    if (keys.current.has('s')) {
      position.current.addScaledVector(planarForward.current, -speed * delta)
    }
    if (keys.current.has('a')) {
      position.current.addScaledVector(planarRight.current, -speed * delta)
    }
    if (keys.current.has('d')) {
      position.current.addScaledVector(planarRight.current, speed * delta)
    }

    verticalOffset.current.set(0, 0, 0)
    if (keys.current.has('q') || keys.current.has('control') || keys.current.has('meta')) {
      verticalOffset.current.y -= speed * 0.8 * delta
    }
    if (keys.current.has('e') || keys.current.has(' ')) {
      verticalOffset.current.y += speed * 0.8 * delta
    }
    position.current.add(verticalOffset.current)

    camera.position.copy(position.current)
    rotationEuler.current.set(pitch.current, yaw.current, 0, 'YXZ')
    camera.quaternion.setFromEuler(rotationEuler.current)

    if (onFocusChange) {
      // Project the center of the benchmark camera onto the ground plane so the
      // streamed tile window matches what a player-like camera would keep loaded.
      viewDirection.current.set(0, 0, -1).applyQuaternion(camera.quaternion).normalize()
      const groundDistance = position.current.y / Math.max(0.12, -viewDirection.current.y)
      focusPoint.current.copy(position.current).addScaledVector(viewDirection.current, groundDistance)

      // Fall back to a simple planar anchor when the camera is nearly parallel to the ground.
      if (!Number.isFinite(focusPoint.current.x) || !Number.isFinite(focusPoint.current.z)) {
        focusPoint.current.copy(position.current).addScaledVector(planarForward.current, 10)
      }

      onFocusChange({
        camera: {
          x: position.current.x,
          z: position.current.z,
        },
        focus: {
          x: focusPoint.current.x,
          z: focusPoint.current.z,
        },
      })
    }
  })

  return null
}

function Ground() {
  return (
    <>
      <group position={[0, -0.58, 0]}>
        <mesh rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
          <planeGeometry args={[240, 240]} />
          <meshStandardMaterial color="#65775e" roughness={1} />
        </mesh>
      </group>
      <group position={[0, -0.5, 0]}>
        <mesh rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
          <planeGeometry args={[216, 216]} />
          <meshStandardMaterial color="#879985" roughness={0.98} />
        </mesh>
      </group>
      <group position={[0, -0.495, 0]}>
        <mesh rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
          <ringGeometry args={[18, 96, 48]} />
          <meshStandardMaterial color="#98a78f" roughness={0.95} />
        </mesh>
      </group>
      <gridHelper args={[240, 240, '#728269', '#90a081']} position={[0, -0.47, 0]} />
    </>
  )
}

function Tiles({ tiles, now, fillVoidTiles }: { tiles: VisibleTile[]; now: number; fillVoidTiles: boolean }) {
  const dirtTiles: VisibleTile[] = []
  const regrowingTiles: VisibleTile[] = []
  const voidTiles: VisibleTile[] = []

  for (const tile of tiles) {
    if (tile.state === 'dirt') {
      dirtTiles.push(tile)
      continue
    }
    if (tile.state === 'regrowing') {
      regrowingTiles.push(tile)
      continue
    }
    voidTiles.push(tile)
  }

  return (
    <group>
      {/* Batch each tile family so the floor cost stays mostly flat as the view grows. */}
      {dirtTiles.length > 0 ? <DirtTileInstances tiles={dirtTiles} capacity={tiles.length} /> : null}
      {regrowingTiles.length > 0 ? <RegrowingTileInstances tiles={regrowingTiles} now={now} capacity={tiles.length} /> : null}
      {voidTiles.length > 0 ? <VoidTileInstances tiles={voidTiles} capacity={tiles.length} fillVoidTiles={fillVoidTiles} /> : null}
    </group>
  )
}

function DirtTileInstances({ tiles, capacity }: { tiles: VisibleTile[]; capacity: number }) {
  const baseRef = useRef<THREE.InstancedMesh>(null)
  const insetRef = useRef<THREE.InstancedMesh>(null)
  const decalRef = useRef<THREE.InstancedMesh>(null)
  const texture = getSharedDirtDecalTexture()

  useLayoutEffect(() => {
    applyTileMatrices(baseRef.current, tiles, { y: -0.08, scaleY: 0.14, scaleXZ: 0.94 })
    applyTileMatrices(insetRef.current, tiles, { y: -0.035, scaleY: 0.045, scaleXZ: 0.84 })
    applyDirtDecalMatrices(decalRef.current, tiles)
  }, [tiles])

  return (
    <>
      <instancedMesh key={`dirt-base-${capacity}`} ref={baseRef} args={[undefined, undefined, capacity]} frustumCulled={false}>
        <boxGeometry args={[1, 1, 1]} />
        <meshStandardMaterial color="#6f5432" roughness={0.94} />
      </instancedMesh>
      <instancedMesh key={`dirt-inset-${capacity}`} ref={insetRef} args={[undefined, undefined, capacity]} frustumCulled={false}>
        <boxGeometry args={[1, 1, 1]} />
        <meshStandardMaterial color="#8b6738" roughness={1} />
      </instancedMesh>
      <instancedMesh key={`dirt-decal-${capacity}`} ref={decalRef} args={[undefined, undefined, capacity]} frustumCulled={false}>
        <planeGeometry args={[0.8, 0.8]} />
        <meshStandardMaterial
          map={texture}
          transparent
          alphaTest={0.18}
          roughness={1}
          metalness={0}
          color="#ffffff"
        />
      </instancedMesh>
    </>
  )
}

function RegrowingTileInstances({ tiles, now, capacity }: { tiles: VisibleTile[]; now: number; capacity: number }) {
  const baseRef = useRef<THREE.InstancedMesh>(null)
  const stripeRef = useRef<THREE.InstancedMesh>(null)
  const markerRef = useRef<THREE.InstancedMesh>(null)

  useLayoutEffect(() => {
    applyTileMatrices(baseRef.current, tiles, { y: -0.08, scaleY: 0.14, scaleXZ: 0.94 })
    applyTileMatrices(stripeRef.current, tiles, { y: -0.017, scaleY: 0.028, scaleX: 0.46, scaleZ: 0.12, rotationY: Math.PI / 4 })
    applyRegrowMarkerMatrices(markerRef.current, tiles, now)
  }, [now, tiles])

  return (
    <>
      <instancedMesh key={`regrow-base-${capacity}`} ref={baseRef} args={[undefined, undefined, capacity]} frustumCulled={false}>
        <boxGeometry args={[1, 1, 1]} />
        <meshStandardMaterial color="#7f9a8c" roughness={0.94} />
      </instancedMesh>
      <instancedMesh key={`regrow-stripe-${capacity}`} ref={stripeRef} args={[undefined, undefined, capacity]} frustumCulled={false}>
        <boxGeometry args={[1, 1, 1]} />
        <meshStandardMaterial color="#ecf0e4" roughness={0.42} emissive="#f3f3dc" emissiveIntensity={0.06} />
      </instancedMesh>
      <instancedMesh key={`regrow-marker-${capacity}`} ref={markerRef} args={[undefined, undefined, capacity]} frustumCulled={false}>
        <cylinderGeometry args={[0.18, 0.18, 0.05, 14]} />
        <meshStandardMaterial color="#f3ead1" emissive="#f4f1cb" emissiveIntensity={0.12} vertexColors />
      </instancedMesh>
    </>
  )
}

function VoidTileInstances({
  tiles,
  capacity,
  fillVoidTiles,
}: {
  tiles: VisibleTile[]
  capacity: number
  fillVoidTiles: boolean
}) {
  const baseRef = useRef<THREE.InstancedMesh>(null)
  const insetRef = useRef<THREE.InstancedMesh>(null)

  useLayoutEffect(() => {
    if (fillVoidTiles) {
      applyTileMatrices(baseRef.current, tiles, { y: -0.08, scaleY: 0.14, scaleXZ: 0.94 })
      applyTileMatrices(insetRef.current, tiles, { y: -0.035, scaleY: 0.038, scaleXZ: 0.82 })
      return
    }

    applyTileMatrices(baseRef.current, tiles, { y: -0.5, scaleY: 0.28, scaleXZ: 0.94 })
    applyTileMatrices(insetRef.current, tiles, { y: -0.48, scaleY: 0.02, scaleXZ: 0.82 })
  }, [fillVoidTiles, tiles])

  return (
    <>
      <instancedMesh key={`void-base-${capacity}`} ref={baseRef} args={[undefined, undefined, capacity]} frustumCulled={false}>
        <boxGeometry args={[1, 1, 1]} />
        <meshStandardMaterial color={fillVoidTiles ? '#54684f' : '#39402b'} roughness={0.94} />
      </instancedMesh>
      <instancedMesh key={`void-inset-${capacity}`} ref={insetRef} args={[undefined, undefined, capacity]} frustumCulled={false}>
        <boxGeometry args={[1, 1, 1]} />
        <meshStandardMaterial color={fillVoidTiles ? '#40513e' : '#2f3627'} roughness={1} />
      </instancedMesh>
    </>
  )
}

function Players({
  players,
  selfSessionId,
  actorStyle,
}: {
  players: VisiblePlayer[]
  selfSessionId: string
  actorStyle: 'default' | 'benchmark'
}) {
  const selfPlayers: VisiblePlayer[] = []
  const crowdPlayers: VisiblePlayer[] = []

  if (actorStyle === 'benchmark') {
    return (
      <group>
        {players.map((player) => (
          <RoombaActor key={player.sessionId} player={player} actorStyle={actorStyle} />
        ))}
      </group>
    )
  }

  for (const player of players) {
    if (player.sessionId === selfSessionId) {
      selfPlayers.push(player)
      continue
    }
    crowdPlayers.push(player)
  }

  return (
    <group>
      {selfPlayers.map((player) => (
        <RoombaActor key={player.sessionId} player={player} actorStyle={actorStyle} />
      ))}
      {crowdPlayers.length > 0 ? <CrowdRoombas players={crowdPlayers} capacity={crowdPlayers.length} actorStyle={actorStyle} /> : null}
    </group>
  )
}

function RoombaActor({ player, actorStyle }: { player: VisiblePlayer; actorStyle: 'default' | 'benchmark' }) {
  const initialYaw = headingToRotation(player.heading)
  const groupRef = useRef<THREE.Group>(null)
  const targetPosition = useRef(new THREE.Vector3(player.x, 0.18, player.z))
  const targetYaw = useRef(initialYaw)
  const smoothedYaw = useRef(initialYaw)
  const initialized = useRef(false)

  useEffect(() => {
    targetPosition.current.set(player.x, 0.18, player.z)
    targetYaw.current = headingToRotation(player.heading)
  }, [player.x, player.z, player.heading])

  useFrame((_, delta) => {
    const group = groupRef.current
    if (!group) {
      return
    }

    if (!initialized.current) {
      group.position.copy(targetPosition.current)
      smoothedYaw.current = targetYaw.current
      group.rotation.set(0, smoothedYaw.current, 0)
      initialized.current = true
    }

    const moveLerp = 1 - Math.exp(-delta * 14)
    const turnLerp = 1 - Math.exp(-delta * 18)
    group.position.lerp(targetPosition.current, moveLerp)
    smoothedYaw.current = dampAngle(smoothedYaw.current, targetYaw.current, turnLerp)
    group.rotation.set(0, smoothedYaw.current, 0)
  })

  return (
    <group ref={groupRef}>
      <RoombaModel color={player.color} actorStyle={actorStyle} />
    </group>
  )
}

function RoombaModel({ color, actorStyle }: { color: string; actorStyle: 'default' | 'benchmark' }) {
  const shellBase = new THREE.Color(color)
  const benchmarkStyle = actorStyle === 'benchmark'
  const shellOuter = benchmarkStyle ? tintColor(shellBase, '#ffffff', 0.08) : tintColor(shellBase, '#06080d', 0.5)
  const shellMid = benchmarkStyle ? tintColor(shellBase, '#ffffff', 0.22) : tintColor(shellBase, '#10151d', 0.28)
  const shellTop = benchmarkStyle ? tintColor(shellBase, '#ffffff', 0.55) : tintColor(shellBase, '#ffffff', 0.12)
  const trimColor = benchmarkStyle ? tintColor(shellBase, '#1a1f26', 0.25) : tintColor(shellBase, '#050608', 0.64)
  const accentColor = benchmarkStyle ? tintColor(shellBase, '#ffffff', 0.72) : tintColor(shellBase, '#ffffff', 0.36)

  return (
    <group>
      <mesh castShadow receiveShadow>
        <cylinderGeometry args={[0.44, 0.47, 0.14, 48]} />
        <meshStandardMaterial color={shellOuter} metalness={benchmarkStyle ? 0.12 : 0.45} roughness={benchmarkStyle ? 0.52 : 0.28} />
      </mesh>

      <mesh position={[0, 0.05, 0]} castShadow>
        <cylinderGeometry args={[0.4, 0.42, 0.04, 48]} />
        <meshStandardMaterial color={shellMid} metalness={benchmarkStyle ? 0.1 : 0.55} roughness={benchmarkStyle ? 0.46 : 0.22} />
      </mesh>

      <mesh position={[0, 0.08, 0]} castShadow>
        <cylinderGeometry args={[0.31, 0.33, 0.03, 40]} />
        <meshStandardMaterial color={shellTop} metalness={benchmarkStyle ? 0.08 : 0.35} roughness={benchmarkStyle ? 0.32 : 0.24} />
      </mesh>

      <mesh position={[0, 0.1, 0]} rotation={[Math.PI / 2, 0, 0]}>
        <torusGeometry args={[0.235, 0.022, 14, 48]} />
        <meshStandardMaterial color={accentColor} emissive={accentColor} emissiveIntensity={benchmarkStyle ? 0.24 : 0.16} />
      </mesh>

      <mesh position={[0, 0.112, 0]} castShadow>
        <cylinderGeometry args={[0.15, 0.15, 0.025, 32]} />
        <meshStandardMaterial color="#f2f3ef" roughness={0.18} metalness={0.1} />
      </mesh>

      <mesh position={[0, 0.116, 0]} castShadow>
        <cylinderGeometry args={[0.11, 0.11, 0.012, 32]} />
        <meshStandardMaterial color="#e9f4dc" emissive="#b7f06d" emissiveIntensity={0.3} />
      </mesh>

      <mesh position={[0, 0.086, -0.12]} castShadow>
        <boxGeometry args={[0.25, 0.035, 0.085]} />
        <meshStandardMaterial color={trimColor} metalness={0.35} roughness={0.3} />
      </mesh>

      <mesh position={[0, 0.146, -0.34]} castShadow>
        <cylinderGeometry args={[0.045, 0.052, 0.04, 24]} />
        <meshStandardMaterial color={trimColor} metalness={0.55} roughness={0.2} />
      </mesh>

      <mesh position={[0, 0.17, -0.34]} castShadow>
        <cylinderGeometry args={[0.032, 0.032, 0.012, 20]} />
        <meshStandardMaterial color="#0b0d11" metalness={0.7} roughness={0.18} />
      </mesh>

      <mesh position={[0, -0.015, 0.39]} castShadow>
        <boxGeometry args={[0.5, 0.05, 0.08]} />
        <meshStandardMaterial color={trimColor} roughness={0.4} metalness={0.2} />
      </mesh>

      <mesh position={[0.16, 0.084, 0.14]} castShadow>
        <boxGeometry args={[0.045, 0.014, 0.08]} />
        <meshStandardMaterial color={trimColor} roughness={0.3} />
      </mesh>
      <mesh position={[0.05, 0.084, 0.14]} castShadow>
        <boxGeometry args={[0.045, 0.014, 0.08]} />
        <meshStandardMaterial color={trimColor} roughness={0.3} />
      </mesh>
      <mesh position={[-0.06, 0.084, 0.14]} castShadow>
        <boxGeometry args={[0.045, 0.014, 0.08]} />
        <meshStandardMaterial color={trimColor} roughness={0.3} />
      </mesh>
      <mesh position={[-0.17, 0.084, 0.14]} castShadow>
        <boxGeometry args={[0.045, 0.014, 0.08]} />
        <meshStandardMaterial color={trimColor} roughness={0.3} />
      </mesh>
    </group>
  )
}

interface CrowdActorState {
  position: THREE.Vector3
  targetPosition: THREE.Vector3
  yaw: number
  targetYaw: number
  bodyColor: THREE.Color
  topColor: THREE.Color
  buttonColor: THREE.Color
}

function CrowdRoombas({
  players,
  capacity,
  actorStyle,
}: {
  players: VisiblePlayer[]
  capacity: number
  actorStyle: 'default' | 'benchmark'
}) {
  const statesRef = useRef(new Map<string, CrowdActorState>())
  const bodyRef = useRef<THREE.InstancedMesh>(null)
  const topRef = useRef<THREE.InstancedMesh>(null)
  const buttonRef = useRef<THREE.InstancedMesh>(null)
  const sensorRef = useRef<THREE.InstancedMesh>(null)
  const benchmarkStyle = actorStyle === 'benchmark'

  useEffect(() => {
    const nextIds = new Set(players.map((player) => player.sessionId))
    for (const [sessionId] of statesRef.current) {
      if (!nextIds.has(sessionId)) {
        statesRef.current.delete(sessionId)
      }
    }

    for (const player of players) {
      const existing = statesRef.current.get(player.sessionId)
      if (existing) {
        existing.targetPosition.set(player.x, 0.18, player.z)
        existing.targetYaw = headingToRotation(player.heading)
        existing.bodyColor.copy(benchmarkStyle ? tintColor(player.color, '#ffffff', 0.16) : tintColor(player.color, '#06080d', 0.42))
        existing.topColor.copy(benchmarkStyle ? tintColor(player.color, '#ffffff', 0.56) : tintColor(player.color, '#ffffff', 0.18))
        existing.buttonColor.copy(benchmarkStyle ? tintColor(player.color, '#ffffff', 0.82) : tintColor(player.color, '#ffffff', 0.36))
        continue
      }

      const yaw = headingToRotation(player.heading)
      statesRef.current.set(player.sessionId, {
        position: new THREE.Vector3(player.x, 0.18, player.z),
        targetPosition: new THREE.Vector3(player.x, 0.18, player.z),
        yaw,
        targetYaw: yaw,
        bodyColor: benchmarkStyle ? tintColor(player.color, '#ffffff', 0.16) : tintColor(player.color, '#06080d', 0.42),
        topColor: benchmarkStyle ? tintColor(player.color, '#ffffff', 0.56) : tintColor(player.color, '#ffffff', 0.18),
        buttonColor: benchmarkStyle ? tintColor(player.color, '#ffffff', 0.82) : tintColor(player.color, '#ffffff', 0.36),
      })
    }
  }, [benchmarkStyle, players])

  useFrame((_, delta) => {
    const bodyMesh = bodyRef.current
    const topMesh = topRef.current
    const buttonMesh = buttonRef.current
    const sensorMesh = sensorRef.current
    if (!bodyMesh || !topMesh || !buttonMesh || !sensorMesh) {
      return
    }

    const moveLerp = 1 - Math.exp(-delta * 14)
    const turnLerp = 1 - Math.exp(-delta * 18)
    const playerCount = players.length
    // Remote roombas share a single instanced crowd model to keep benchmark draw calls low.
    bodyMesh.count = playerCount
    topMesh.count = playerCount
    buttonMesh.count = playerCount
    sensorMesh.count = playerCount

    for (let index = 0; index < playerCount; index += 1) {
      const player = players[index]
      const state = statesRef.current.get(player.sessionId)
      if (!state) {
        continue
      }

      state.position.lerp(state.targetPosition, moveLerp)
      state.yaw = dampAngle(state.yaw, state.targetYaw, turnLerp)

      applyInstanceTransform(bodyMesh, index, state.position, 0.46, 0.13, 0.46)
      applyInstanceTransform(topMesh, index, offsetPosition(state.position, 0, 0.055, 0), 0.32, 0.03, 0.32)
      applyInstanceTransform(buttonMesh, index, offsetPosition(state.position, 0, 0.094, 0), 0.12, 0.016, 0.12)
      applySensorTransform(sensorMesh, index, state.position, state.yaw)

      bodyMesh.setColorAt(index, state.bodyColor)
      topMesh.setColorAt(index, state.topColor)
      buttonMesh.setColorAt(index, state.buttonColor)
      sensorMesh.setColorAt(index, INSTANCE_COLOR.set('#141820'))
    }

    bodyMesh.instanceMatrix.needsUpdate = true
    topMesh.instanceMatrix.needsUpdate = true
    buttonMesh.instanceMatrix.needsUpdate = true
    sensorMesh.instanceMatrix.needsUpdate = true
    bodyMesh.instanceColor!.needsUpdate = true
    topMesh.instanceColor!.needsUpdate = true
    buttonMesh.instanceColor!.needsUpdate = true
    sensorMesh.instanceColor!.needsUpdate = true
  })

  return (
    <group>
      <instancedMesh key={`crowd-body-${capacity}`} ref={bodyRef} args={[undefined, undefined, capacity]} frustumCulled={false}>
        <cylinderGeometry args={[1, 1, 1, 18]} />
        <meshStandardMaterial metalness={benchmarkStyle ? 0.08 : 0.3} roughness={benchmarkStyle ? 0.46 : 0.4} vertexColors />
      </instancedMesh>
      <instancedMesh key={`crowd-top-${capacity}`} ref={topRef} args={[undefined, undefined, capacity]} frustumCulled={false}>
        <cylinderGeometry args={[1, 1, 1, 16]} />
        <meshStandardMaterial metalness={benchmarkStyle ? 0.02 : 0.18} roughness={benchmarkStyle ? 0.24 : 0.3} vertexColors />
      </instancedMesh>
      <instancedMesh key={`crowd-button-${capacity}`} ref={buttonRef} args={[undefined, undefined, capacity]} frustumCulled={false}>
        <cylinderGeometry args={[1, 1, 1, 14]} />
        <meshStandardMaterial emissive="#ffffff" emissiveIntensity={benchmarkStyle ? 0.28 : 0.12} vertexColors />
      </instancedMesh>
      <instancedMesh key={`crowd-sensor-${capacity}`} ref={sensorRef} args={[undefined, undefined, capacity]} frustumCulled={false}>
        <cylinderGeometry args={[1, 1, 1, 12]} />
        <meshStandardMaterial metalness={0.45} roughness={0.22} vertexColors />
      </instancedMesh>
    </group>
  )
}

function DustBunnies({ enemies }: { enemies: VisibleEnemy[] }) {
  return (
    <group>
      {enemies.map((enemy) => (
        <DustBunnyActor key={enemy.enemyId} enemy={enemy} />
      ))}
    </group>
  )
}

function DustBunnyActor({ enemy }: { enemy: VisibleEnemy }) {
  const initialYaw = headingToRotation(enemy.heading)
  const groupRef = useRef<THREE.Group>(null)
  const targetPosition = useRef(new THREE.Vector3(enemy.x, 0.24, enemy.z))
  const targetYaw = useRef(initialYaw)
  const smoothedYaw = useRef(initialYaw)
  const initialized = useRef(false)

  useEffect(() => {
    targetPosition.current.set(enemy.x, 0.24, enemy.z)
    targetYaw.current = headingToRotation(enemy.heading)
  }, [enemy.x, enemy.z, enemy.heading])

  useFrame((_, delta) => {
    const group = groupRef.current
    if (!group) {
      return
    }

    if (!initialized.current) {
      group.position.copy(targetPosition.current)
      smoothedYaw.current = targetYaw.current
      group.rotation.set(0, smoothedYaw.current, 0)
      initialized.current = true
    }

    const moveLerp = 1 - Math.exp(-delta * 12)
    const turnLerp = 1 - Math.exp(-delta * 14)
    group.position.lerp(targetPosition.current, moveLerp)
    smoothedYaw.current = dampAngle(smoothedYaw.current, targetYaw.current, turnLerp)
    group.rotation.set(0, smoothedYaw.current, 0)
  })

  return (
    <group ref={groupRef}>
      <mesh castShadow>
        <sphereGeometry args={[0.26 + enemy.health * 0.04, 18, 18]} />
        <meshStandardMaterial color="#d7d2d9" roughness={0.95} />
      </mesh>
      <mesh position={[0, 0.08, -0.18]} castShadow>
        <sphereGeometry args={[0.12, 12, 12]} />
        <meshStandardMaterial color="#efe6ee" roughness={0.8} />
      </mesh>
      <mesh position={[0.11, 0.12, -0.27]}>
        <sphereGeometry args={[0.04, 10, 10]} />
        <meshStandardMaterial color="#be3f43" emissive="#ff6a6e" emissiveIntensity={0.4} />
      </mesh>
      <mesh position={[-0.11, 0.12, -0.27]}>
        <sphereGeometry args={[0.04, 10, 10]} />
        <meshStandardMaterial color="#be3f43" emissive="#ff6a6e" emissiveIntensity={0.4} />
      </mesh>
      <mesh position={[0.16, 0.28, 0.04]} rotation={[0, 0, -0.3]}>
        <capsuleGeometry args={[0.03, 0.18, 4, 8]} />
        <meshStandardMaterial color="#f2ecf3" />
      </mesh>
      <mesh position={[-0.16, 0.28, 0.04]} rotation={[0, 0, 0.3]}>
        <capsuleGeometry args={[0.03, 0.18, 4, 8]} />
        <meshStandardMaterial color="#f2ecf3" />
      </mesh>
    </group>
  )
}

function applyTileMatrices(
  mesh: THREE.InstancedMesh | null,
  tiles: VisibleTile[],
  options: {
    y: number
    scaleY: number
    scaleXZ?: number
    scaleX?: number
    scaleZ?: number
    rotationY?: number
  },
): void {
  if (!mesh) {
    return
  }

  mesh.count = tiles.length
  for (let index = 0; index < tiles.length; index += 1) {
    const tile = tiles[index]
    INSTANCE_OBJECT.position.set(tile.x, options.y, tile.z)
    INSTANCE_OBJECT.rotation.set(0, options.rotationY ?? 0, 0)
    INSTANCE_OBJECT.scale.set(options.scaleX ?? options.scaleXZ ?? 1, options.scaleY, options.scaleZ ?? options.scaleXZ ?? 1)
    INSTANCE_OBJECT.updateMatrix()
    mesh.setMatrixAt(index, INSTANCE_OBJECT.matrix)
  }
  mesh.instanceMatrix.needsUpdate = true
}

function applyDirtDecalMatrices(mesh: THREE.InstancedMesh | null, tiles: VisibleTile[]): void {
  if (!mesh) {
    return
  }

  mesh.count = tiles.length
  for (let index = 0; index < tiles.length; index += 1) {
    const tile = tiles[index]
    const seed = tileSeed(tile.x, tile.z)
    const rotation = sampleSeed(seed * 1.9, Math.PI)
    const scale = sampleRange(seed * 3.7, 0.88, 1.04)
    INSTANCE_OBJECT.position.set(tile.x, -0.002, tile.z)
    INSTANCE_OBJECT.rotation.set(-Math.PI / 2, 0, rotation)
    INSTANCE_OBJECT.scale.set(scale, scale, 1)
    INSTANCE_OBJECT.updateMatrix()
    mesh.setMatrixAt(index, INSTANCE_OBJECT.matrix)
  }
  mesh.instanceMatrix.needsUpdate = true
}

function applyRegrowMarkerMatrices(mesh: THREE.InstancedMesh | null, tiles: VisibleTile[], now: number): void {
  if (!mesh) {
    return
  }

  mesh.count = tiles.length
  for (let index = 0; index < tiles.length; index += 1) {
    const tile = tiles[index]
    const intensity = tile.regrowAt ? Math.max(0.15, Math.min(1, (tile.regrowAt - now) / 60_000)) : 0.2
    INSTANCE_OBJECT.position.set(tile.x, 0.16, tile.z)
    INSTANCE_OBJECT.rotation.set(0, 0, 0)
    INSTANCE_OBJECT.scale.set(1, 1, 1)
    INSTANCE_OBJECT.updateMatrix()
    mesh.setMatrixAt(index, INSTANCE_OBJECT.matrix)
    mesh.setColorAt(index, INSTANCE_COLOR.setRGB(0.75 + intensity * 0.2, 0.72 + intensity * 0.2, 0.62 + intensity * 0.24))
  }
  mesh.instanceMatrix.needsUpdate = true
  if (mesh.instanceColor) {
    mesh.instanceColor.needsUpdate = true
  }
}

function applyInstanceTransform(mesh: THREE.InstancedMesh, index: number, position: THREE.Vector3, scaleX: number, scaleY: number, scaleZ: number): void {
  INSTANCE_OBJECT.position.copy(position)
  INSTANCE_OBJECT.rotation.set(0, 0, 0)
  INSTANCE_OBJECT.scale.set(scaleX, scaleY, scaleZ)
  INSTANCE_OBJECT.updateMatrix()
  mesh.setMatrixAt(index, INSTANCE_OBJECT.matrix)
}

function applySensorTransform(mesh: THREE.InstancedMesh, index: number, position: THREE.Vector3, yaw: number): void {
  INSTANCE_SENSOR_OFFSET.set(0, 0.126, -0.32).applyAxisAngle(THREE.Object3D.DEFAULT_UP, yaw)
  INSTANCE_POSITION.copy(position).add(INSTANCE_SENSOR_OFFSET)
  applyInstanceTransform(mesh, index, INSTANCE_POSITION, 0.041, 0.032, 0.041)
}

function offsetPosition(position: THREE.Vector3, x: number, y: number, z: number): THREE.Vector3 {
  return INSTANCE_POSITION.copy(position).add(INSTANCE_SENSOR_OFFSET.set(x, y, z))
}

function headingToRotation(heading: VisiblePlayer['heading']): number {
  switch (heading) {
    case 'up':
      return 0
    case 'right':
      return -Math.PI / 2
    case 'down':
      return Math.PI
    case 'left':
      return Math.PI / 2
  }
}

function dampAngle(current: number, target: number, amount: number): number {
  const delta = normalizeAngle(target - current)
  return current + delta * amount
}

function normalizeAngle(angle: number): number {
  let normalized = angle
  while (normalized > Math.PI) {
    normalized -= Math.PI * 2
  }
  while (normalized < -Math.PI) {
    normalized += Math.PI * 2
  }
  return normalized
}

function forwardFromYaw(yaw: number): THREE.Vector3 {
  return new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw))
}

function tileSeed(x: number, z: number): number {
  const value = Math.sin(x * 127.1 + z * 311.7) * 43_758.5453
  return value - Math.floor(value)
}

function sampleSeed(seed: number, amplitude: number): number {
  const normalized = Math.sin(seed * 912.73) * 43_758.5453
  const fractional = normalized - Math.floor(normalized)
  return (fractional - 0.5) * amplitude * 2
}

function sampleRange(seed: number, min: number, max: number): number {
  const normalized = Math.sin(seed * 613.27) * 43_758.5453
  const fractional = normalized - Math.floor(normalized)
  return min + fractional * (max - min)
}

function clampScalar(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function tintColor(base: THREE.ColorRepresentation, target: THREE.ColorRepresentation, amount: number): THREE.Color {
  return new THREE.Color(base).lerp(new THREE.Color(target), amount)
}

function getSharedDirtDecalTexture(): THREE.Texture {
  if (sharedDirtDecalTexture) {
    return sharedDirtDecalTexture
  }

  const size = 128
  const canvas =
    typeof document !== 'undefined'
      ? document.createElement('canvas')
      : typeof OffscreenCanvas !== 'undefined'
        ? new OffscreenCanvas(size, size)
        : null

  if (!canvas) {
    sharedDirtDecalTexture = new THREE.Texture()
    return sharedDirtDecalTexture
  }

  canvas.width = size
  canvas.height = size
  const context = canvas.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null
  if (!context) {
    sharedDirtDecalTexture = new THREE.Texture()
    return sharedDirtDecalTexture
  }

  context.clearRect(0, 0, size, size)
  context.fillStyle = 'rgba(76, 49, 22, 0.78)'
  drawBlob(context, 70, 58, 36, 28, 0.22)
  context.fillStyle = 'rgba(52, 31, 14, 0.85)'
  drawBlob(context, 50, 72, 20, 14, -0.35)
  context.fillStyle = 'rgba(176, 139, 77, 0.86)'
  context.fillRect(78, 32, 22, 12)

  for (let index = 0; index < 14; index += 1) {
    const seed = index * 17.37 + 2.1
    const x = sampleRange(seed * 1.9, 18, 108)
    const y = sampleRange(seed * 2.7, 20, 110)
    const radius = sampleRange(seed * 3.1, 2.5, 5.5)
    context.fillStyle = index % 3 === 0 ? 'rgba(145, 111, 59, 0.82)' : 'rgba(63, 39, 18, 0.82)'
    context.beginPath()
    context.arc(x, y, radius, 0, Math.PI * 2)
    context.fill()
  }

  context.strokeStyle = 'rgba(38, 24, 10, 0.92)'
  context.lineWidth = 6
  context.lineCap = 'round'
  context.beginPath()
  context.moveTo(44, 85)
  context.lineTo(90, 95)
  context.stroke()

  sharedDirtDecalTexture = new THREE.CanvasTexture(canvas)
  sharedDirtDecalTexture.colorSpace = THREE.SRGBColorSpace
  sharedDirtDecalTexture.needsUpdate = true
  return sharedDirtDecalTexture
}

function drawBlob(
  context: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  x: number,
  y: number,
  radiusX: number,
  radiusY: number,
  rotation: number,
): void {
  context.save()
  context.translate(x, y)
  context.rotate(rotation)
  context.beginPath()
  context.ellipse(0, 0, radiusX, radiusY, 0, 0, Math.PI * 2)
  context.fill()
  context.restore()
}
