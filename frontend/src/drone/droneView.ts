import {
  CallbackPositionProperty,
  CallbackProperty,
  Cartesian3,
  Cartographic,
  Color,
  DistanceDisplayCondition,
  Ellipsoid,
  HeadingPitchRange,
  HeadingPitchRoll,
  Math as CesiumMath,
  Matrix4,
  PolylineDashMaterialProperty,
  Quaternion,
  Transforms,
  type Entity,
  type Viewer,
} from 'cesium'
import { TORONTO_GEOID_OFFSET_M } from '../config'
import { distanceM } from '../places/geo'
import { lerpAngleDeg, StateBuffer } from './interpolate'
import type { CameraMode, DroneSource, DroneState } from './types'

/** Real quadcopter is ~0.5 m across; drawn larger so it's visible from the chase camera. */
const VISUAL_SCALE = 4
const CHASE_RANGE_M = 30
const CHASE_PITCH_DEG = -15
const FPV_TILT_DEG = -10
const TRAIL_INTERVAL_MS = 400
const TRAIL_MAX_POINTS = 600
const HUD_INTERVAL_MS = 200
const POSE_REUSE_MS = 5

/** Local frame with x = north (forward at heading 0), y = west, z = up. */
const NORTH_WEST_UP = Transforms.localFrameToFixedFrameGenerator('north', 'west')

export type HudInfo = {
  state: DroneState
  /** Height above whatever is directly below (ground, roof or terrain); null if unknown. */
  aglM: number | null
  distanceFromHomeM: number
}

type Part = {
  entity: Entity
  /** Offset from the drone centre in the local frame (metres, before scaling). */
  offset: Cartesian3
  /** Extra rotation of the part relative to the drone body. */
  rotation: Quaternion
  position: Cartesian3
  orientation: Quaternion
}

/**
 * Draws the drone in the Cesium scene from a DroneSource and drives the camera
 * modes (chase, first-person, free). Knows nothing about where states come from.
 */
export class DroneView {
  private readonly viewer: Viewer
  private readonly buffer = new StateBuffer()
  private readonly parts: Part[] = []
  private readonly others: Entity[] = []
  private readonly trail: Cartesian3[] = []
  private lastTrailAt = -Infinity
  private readonly dronePosition = new Cartesian3()
  private groundPosition: Cartesian3 | undefined
  private current: DroneState | null = null
  /** When (performance.now) the pose below was computed; recomputed once per frame. */
  private poseAt = -Infinity
  private hasPose = false
  private mode: CameraMode = 'free'
  private chaseHeadingDeg = 0
  private lastFrameAt = performance.now()
  private lastHudAt = 0
  private aglM: number | null = null
  private readonly modeListeners = new Set<(m: CameraMode) => void>()
  private readonly hudListeners = new Set<(h: HudInfo | null) => void>()
  private readonly cleanups: (() => void)[] = []
  private destroyed = false

  constructor(viewer: Viewer, source: DroneSource) {
    this.viewer = viewer
    this.buildModel()
    this.buildOverlays()

    if (source.latest) this.buffer.push(source.latest, performance.now())
    this.cleanups.push(
      source.subscribe((s) => this.buffer.push(s, performance.now())),
      viewer.scene.preRender.addEventListener(() => this.onFrame()),
    )
  }

  get cameraMode() {
    return this.mode
  }

  setCameraMode(mode: CameraMode) {
    if (mode === this.mode) return
    const camera = this.viewer.camera
    camera.lookAtTransform(Matrix4.IDENTITY) // release any lookAt lock
    // The drone drives the camera in chase/FPV; the mouse only in free mode.
    this.viewer.scene.screenSpaceCameraController.enableInputs = mode === 'free'
    if (mode === 'chase' && this.current) this.chaseHeadingDeg = this.current.headingDeg
    this.mode = mode
    for (const listener of this.modeListeners) listener(mode)
  }

  onCameraModeChange(listener: (m: CameraMode) => void) {
    this.modeListeners.add(listener)
    return () => void this.modeListeners.delete(listener)
  }

  /** ~5 times a second: the interpolated state plus height above ground. */
  onHud(listener: (h: HudInfo | null) => void) {
    this.hudListeners.add(listener)
    return () => void this.hudListeners.delete(listener)
  }

  setTrailVisible(show: boolean) {
    const trail = this.others.find((e) => e.id === 'drone-trail')
    if (trail) trail.show = show
  }

  clearTrail() {
    this.trail.length = 0
    this.lastTrailAt = -Infinity
  }

  destroy() {
    if (this.destroyed) return
    this.destroyed = true
    this.cleanups.forEach((fn) => fn())
    if (!this.viewer.isDestroyed()) {
      this.setCameraMode('free')
      for (const e of [...this.parts.map((p) => p.entity), ...this.others]) this.viewer.entities.remove(e)
    }
    this.modeListeners.clear()
    this.hudListeners.clear()
  }

  // --- per frame -------------------------------------------------------------

  /**
   * Computes the drone's pose for this frame, once. Called lazily by the entity
   * callbacks (which Cesium evaluates before preRender) and by onFrame, so the
   * model and the camera always use the same pose: no one-frame lag or shake.
   */
  private updatePose() {
    // Keyed on wall-clock time, not the scene clock: with no timeline the scene clock
    // doesn't advance, so every frame would look like the same frame. Entity callbacks
    // and preRender for one frame run within a few ms; frames are ~16 ms apart.
    const now = performance.now()
    if (now - this.poseAt < POSE_REUSE_MS) return
    this.poseAt = now

    const state = this.buffer.sample(now)
    this.current = state
    this.hasPose = state !== null
    if (!state) return

    Cartesian3.fromDegrees(state.lon, state.lat, state.altAmslM + TORONTO_GEOID_OFFSET_M, Ellipsoid.WGS84, this.dronePosition)
    const hpr = new HeadingPitchRoll(
      CesiumMath.toRadians(state.headingDeg),
      CesiumMath.toRadians(state.pitchDeg),
      CesiumMath.toRadians(state.rollDeg),
    )
    const frame = Transforms.headingPitchRollToFixedFrame(this.dronePosition, hpr, Ellipsoid.WGS84, NORTH_WEST_UP)
    const bodyOrientation = Transforms.headingPitchRollQuaternion(this.dronePosition, hpr, Ellipsoid.WGS84, NORTH_WEST_UP)
    for (const part of this.parts) {
      Matrix4.multiplyByPoint(frame, Cartesian3.multiplyByScalar(part.offset, VISUAL_SCALE, new Cartesian3()), part.position)
      Quaternion.multiply(bodyOrientation, part.rotation, part.orientation)
    }
  }

  private onFrame() {
    if (this.destroyed) return
    const now = performance.now()
    const dt = Math.min((now - this.lastFrameAt) / 1000, 0.1)
    this.lastFrameAt = now

    this.updatePose()
    const state = this.current
    for (const part of this.parts) part.entity.show = this.hasPose && this.mode !== 'fpv' // don't sit inside the model
    for (const e of this.others) if (e.id !== 'drone-trail') e.show = this.hasPose
    if (!state) return

    // Trail: a point every TRAIL_INTERVAL_MS of flight time while airborne.
    if (state.inAir && state.timeMs - this.lastTrailAt >= TRAIL_INTERVAL_MS) {
      this.trail.push(Cartesian3.clone(this.dronePosition))
      if (this.trail.length > TRAIL_MAX_POINTS) this.trail.shift()
      this.lastTrailAt = state.timeMs
    }
    if (state.timeMs < this.lastTrailAt) this.clearTrail() // source restarted

    this.updateCamera(state, dt)

    if (now - this.lastHudAt >= HUD_INTERVAL_MS) {
      this.lastHudAt = now
      this.sampleGround(state)
      const info: HudInfo = {
        state,
        aglM: this.aglM,
        distanceFromHomeM: distanceM(state.lon, state.lat, state.home.lon, state.home.lat),
      }
      for (const listener of this.hudListeners) listener(info)
    }
  }

  private updateCamera(state: DroneState, dt: number) {
    const camera = this.viewer.camera
    if (this.mode === 'chase') {
      // Swing round behind the drone smoothly rather than snapping on every turn.
      this.chaseHeadingDeg = lerpAngleDeg(this.chaseHeadingDeg, state.headingDeg, 1 - Math.exp(-dt * 2.5))
      camera.lookAt(
        this.dronePosition,
        new HeadingPitchRange(
          CesiumMath.toRadians(this.chaseHeadingDeg),
          CesiumMath.toRadians(CHASE_PITCH_DEG),
          CHASE_RANGE_M,
        ),
      )
    } else if (this.mode === 'fpv') {
      camera.lookAtTransform(Matrix4.IDENTITY)
      camera.setView({
        destination: this.dronePosition,
        orientation: {
          heading: CesiumMath.toRadians(state.headingDeg),
          pitch: CesiumMath.toRadians(state.pitchDeg + FPV_TILT_DEG),
          roll: CesiumMath.toRadians(state.rollDeg),
        },
      })
    }
  }

  /** Height of whatever is rendered directly below the drone (Google mesh, terrain or massing). */
  private sampleGround(state: DroneState) {
    const scene = this.viewer.scene
    if (!scene.sampleHeightSupported) return
    const below = Cartographic.fromDegrees(state.lon, state.lat)
    const exclude = [...this.parts.map((p) => p.entity), ...this.others]
    const ground = scene.sampleHeight(below, exclude)
    if (ground === undefined) {
      this.aglM = null
      this.groundPosition = undefined
      return
    }
    this.aglM = state.altAmslM + TORONTO_GEOID_OFFSET_M - ground
    this.groundPosition = Cartesian3.fromDegrees(state.lon, state.lat, ground)
  }

  // --- scene objects ---------------------------------------------------------

  private buildModel() {
    const s = VISUAL_SCALE
    const dark = Color.fromCssColorString('#2b2d31')
    const arm = Color.fromCssColorString('#3a3d42')
    const front = Color.fromCssColorString('#e63946').withAlpha(0.85)
    const back = Color.fromCssColorString('#d9dde3').withAlpha(0.85)
    const yaw45 = (deg: number) => Quaternion.fromAxisAngle(Cartesian3.UNIT_Z, CesiumMath.toRadians(deg))
    const r = 0.163 // rotor centre distance along each axis

    this.addPart('drone-body', new Cartesian3(0, 0, 0), Quaternion.IDENTITY, {
      box: { dimensions: new Cartesian3(0.22 * s, 0.14 * s, 0.07 * s), material: dark },
    })
    this.addPart('drone-nose', new Cartesian3(0.12, 0, 0.005), Quaternion.IDENTITY, {
      box: { dimensions: new Cartesian3(0.04 * s, 0.08 * s, 0.03 * s), material: Color.fromCssColorString('#ff9f1c') },
    })
    for (const [id, deg] of [['drone-arm-a', 45], ['drone-arm-b', -45]] as const) {
      this.addPart(id, new Cartesian3(0, 0, 0.01), yaw45(deg), {
        box: { dimensions: new Cartesian3(0.46 * s, 0.025 * s, 0.02 * s), material: arm },
      })
    }
    // Front rotors red, back rotors light, so the heading is readable from any angle.
    for (const [id, x, y, colour] of [
      ['drone-rotor-fl', r, r, front],
      ['drone-rotor-fr', r, -r, front],
      ['drone-rotor-bl', -r, r, back],
      ['drone-rotor-br', -r, -r, back],
    ] as const) {
      this.addPart(id, new Cartesian3(x, y, 0.035), Quaternion.IDENTITY, {
        cylinder: { length: 0.008 * s, topRadius: 0.09 * s, bottomRadius: 0.09 * s, material: colour },
      })
    }
  }

  private addPart(
    id: string,
    offset: Cartesian3,
    rotation: Quaternion,
    graphics: Pick<Entity.ConstructorOptions, 'box' | 'cylinder'>,
  ) {
    const part: Part = {
      entity: undefined as unknown as Entity,
      offset,
      rotation,
      position: new Cartesian3(),
      orientation: new Quaternion(),
    }
    part.entity = this.viewer.entities.add({
      id,
      name: 'Drone',
      position: new CallbackPositionProperty(() => this.poseFor() && part.position, false),
      orientation: new CallbackProperty(() => this.poseFor() && part.orientation, false),
      ...graphics,
    })
    this.parts.push(part)
  }

  /** For entity callbacks: true once this frame's pose exists (undefined position hides the entity). */
  private poseFor(): true | undefined {
    this.updatePose()
    return this.hasPose ? true : undefined
  }

  private buildOverlays() {
    const entities = this.viewer.entities
    // Flight path.
    this.others.push(
      entities.add({
        id: 'drone-trail',
        polyline: {
          positions: new CallbackProperty(() => this.trail, false),
          width: 3,
          material: Color.fromCssColorString('#ffd166').withAlpha(0.85),
        },
      }),
    )
    // Dashed line straight down to the ground: shows height at a glance.
    this.others.push(
      entities.add({
        id: 'drone-altitude-line',
        polyline: {
          positions: new CallbackProperty(
            () => (this.poseFor() && this.groundPosition ? [this.dronePosition, this.groundPosition] : []),
            false,
          ),
          width: 1.5,
          material: new PolylineDashMaterialProperty({ color: Color.WHITE.withAlpha(0.8), dashLength: 12 }),
        },
      }),
    )
    // A dot that stays visible from far away, when the model itself is too small to see.
    this.others.push(
      entities.add({
        id: 'drone-marker',
        position: new CallbackPositionProperty(() => this.poseFor() && this.dronePosition, false),
        point: {
          pixelSize: 9,
          color: Color.fromCssColorString('#e63946'),
          outlineColor: Color.WHITE,
          outlineWidth: 2,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          distanceDisplayCondition: new DistanceDisplayCondition(250, Number.POSITIVE_INFINITY),
        },
      }),
    )
  }
}
