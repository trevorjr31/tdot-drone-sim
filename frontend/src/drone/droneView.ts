import {
  CallbackPositionProperty,
  CallbackProperty,
  Cartesian2,
  Cartesian3,
  Cartographic,
  Color,
  ColorMaterialProperty,
  DistanceDisplayCondition,
  Ellipsoid,
  HeadingPitchRoll,
  HeightReference,
  LabelStyle,
  Math as CesiumMath,
  Matrix4,
  PolylineDashMaterialProperty,
  Quaternion,
  Transforms,
  VerticalOrigin,
  type Entity,
  type Viewer,
} from 'cesium'
import { TORONTO_GEOID_OFFSET_M } from '../config'
import { distanceM } from '../places/geo'
import { crashState, type CrashSite } from './crash'
import { lerpAngleDeg, StateBuffer } from './interpolate'
import type { DroneSource, DroneState } from './types'

/** Real quadcopter is ~0.5 m across; drawn larger so it's visible from the chase camera. */
const VISUAL_SCALE = 4
/**
 * Propeller spin as drawn, radians per second. Real props turn ~100 times a second, which
 * on screen would alias into a crawl or a stand-still; this reads as fast but smooth.
 */
const ROTOR_SPIN_RAD_S = 28
/** Spin-up and spin-down, as a fraction of full speed per second. */
const ROTOR_SPIN_UP_PER_S = 1.5
/** Starting chase view: this far from the drone, looking down at this angle. */
const CHASE_RANGE_M = 30
const CHASE_PITCH_DEG = -15
/** Zoom limits for the chase camera (scroll wheel). */
const MIN_ZOOM_M = 3
const MAX_ZOOM_M = 30_000 // far enough to see the whole city around the drone
const TRAIL_INTERVAL_MS = 400
const TRAIL_MAX_POINTS = 600
const HUD_INTERVAL_MS = 200
const POSE_REUSE_MS = 5

/** Local frame with x = north (forward at heading 0), y = west, z = up. */
const NORTH_WEST_UP = Transforms.localFrameToFixedFrameGenerator('north', 'west')

export type FlyToTarget = {
  lat: number
  lon: number
  label: string
  /** The place is on a building (picked on the map): its height, metres. */
  building?: { heightM: number }
}

/** A point on a planned route's path, metres above home; `atDrone` points sit over the drone. */
export type PreviewPoint = { lat: number; lon: number; relAltM: number } | { atDrone: true; relAltM: number }

/** A planned route, drawn grey: a labelled marker per stop and the path it will fly. */
export type RoutePreview = {
  markers: { lat: number; lon: number; label: string }[]
  path: PreviewPoint[]
  /** Start the line at the drone (while planning), or at the first point (the rest of a route in flight). */
  fromDrone: boolean
}

const PREVIEW_COLOUR = '#d1d1d6'

export type { CrashSite } from './crash'

/** Within this distance (and nearly stopped) the target counts as reached. */
const TARGET_REACHED_M = 5

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
  /** Propeller: spins about its own axis while armed, this way round (1 or -1), from this angle. */
  spin?: { direction: 1 | -1; phase: number }
  position: Cartesian3
  orientation: Quaternion
}

/**
 * Draws the drone in the Cesium scene from a DroneSource and drives the camera
 * chase camera. Knows nothing about where states come from.
 *
 * The camera always follows the drone: it orbits it at an offset you can change
 * with the mouse (drag to rotate, scroll to zoom), and that offset turns with the
 * drone so the view stays behind it.
 */
export class DroneView {
  private readonly viewer: Viewer
  private readonly buffer = new StateBuffer()
  private readonly parts: Part[] = []
  /** Propellers: angle so far, and speed as a fraction of full (eases up when armed, down when not). */
  private rotorAngle = 0
  private rotorSpeed = 0
  private rotorAt = performance.now()
  private readonly others: Entity[] = []
  private readonly trail: Cartesian3[] = []
  private lastTrailAt = -Infinity
  private readonly dronePosition = new Cartesian3()
  private groundPosition: Cartesian3 | undefined
  private current: DroneState | null = null
  /** When (performance.now) the pose below was computed; recomputed once per frame. */
  private poseAt = -Infinity
  private hasPose = false
  /** Camera offset from the drone in its local east-north-up frame (metres). */
  private orbit: Cartesian3 | null = null
  /** Smoothed drone heading the orbit was last turned to. */
  private orbitHeadingDeg = 0
  private lastFrameAt = performance.now()
  private lastHudAt = 0
  private aglM: number | null = null
  private readonly hudListeners = new Set<(h: HudInfo | null) => void>()
  private readonly targetListeners = new Set<(t: FlyToTarget | null) => void>()
  private target: FlyToTarget | null = null
  private crashSite: { site: CrashSite; at: number } | null = null
  private readonly targetPosition = new Cartesian3()
  /** targetPosition is valid for the current frame (computed with the pose). */
  private hasTargetPosition = false
  /** A planned route, before it's flown (drawn grey). */
  private preview: RoutePreview | null = null
  /** The preview's path for the current frame. */
  private previewPath: Cartesian3[] = []
  private previewMarkers: Entity[] = []
  private readonly cleanups: (() => void)[] = []
  private unsubscribeSource: (() => void) | undefined
  private source: DroneSource | undefined
  private destroyed = false

  constructor(viewer: Viewer, source: DroneSource) {
    this.viewer = viewer
    // Mouse: drag rotates around the drone, scroll zooms. No panning away from it.
    const controller = viewer.scene.screenSpaceCameraController
    controller.enableInputs = true
    controller.enableTranslate = false
    controller.enableLook = false
    controller.minimumZoomDistance = MIN_ZOOM_M
    controller.maximumZoomDistance = MAX_ZOOM_M
    // Zoom through buildings: Cesium normally picks the surface under the screen centre
    // and slows the zoom to a stop at it, so a building between the camera and the drone
    // blocks zooming in. With no picking, zoom steps scale with the distance to the drone.
    controller.minimumPickingTerrainHeight = 0
    controller.minimumPickingTerrainDistanceWithInertia = 0
    this.buildModel()
    this.buildOverlays()

    this.setSource(source)
    this.cleanups.push(viewer.scene.preRender.addEventListener(() => this.onFrame()))
  }

  /** Set where the drone's state comes from. Clears the trail. */
  setSource(source: DroneSource) {
    if (source === this.source) return
    this.unsubscribeSource?.()
    this.source = source
    this.buffer.clear()
    this.clearTrail()
    this.aglM = null
    this.groundPosition = undefined
    if (source.latest) this.buffer.push(source.latest, performance.now())
    this.unsubscribeSource = source.subscribe((s) => this.buffer.push(s, performance.now()))
  }

  /** ~5 times a second: the interpolated state plus height above ground. */
  onHud(listener: (h: HudInfo | null) => void) {
    this.hudListeners.add(listener)
    return () => void this.hudListeners.delete(listener)
  }

  /**
   * The drone hit a building: from now on draw it falling from the impact point
   * (tumbling) and lying at the foot of the wall, instead of where the source says.
   * PX4's physics doesn't know about the building, so its own position would be inside it.
   */
  crash(site: CrashSite) {
    // Land on what's actually below in the 3D scene (e.g. a podium roof), not the street
    // level from the City data, which could be inside a lower part of the building.
    const exclude = [...this.parts.map((p) => p.entity), ...this.others]
    const below = this.viewer.scene.sampleHeightSupported
      ? this.viewer.scene.sampleHeight(Cartographic.fromDegrees(site.lon, site.lat), exclude)
      : undefined
    if (below !== undefined) {
      const belowAmslM = below - TORONTO_GEOID_OFFSET_M
      if (belowAmslM < site.altAmslM - 0.5) site = { ...site, groundAmslM: belowAmslM }
    }
    this.crashSite = { site, at: performance.now() }
    this.target = null
    for (const listener of this.targetListeners) listener(null)
    this.poseAt = -Infinity
  }

  clearCrash() {
    this.crashSite = null
    this.buffer.clear()
    this.clearTrail()
    this.poseAt = -Infinity
  }

  get crashed() {
    return this.crashSite !== null
  }

  /** Show where the drone is flying to; cleared automatically on arrival. */
  setTarget(target: FlyToTarget | null) {
    this.target = target
    this.hasTargetPosition = false
    this.poseAt = -Infinity // recompute (including the target position) before the next draw
    for (const listener of this.targetListeners) listener(target)
  }

  /** Show a planned route (grey): while planning, and the stops still to come in flight. */
  setPreview(preview: RoutePreview | null) {
    this.preview = preview
    this.previewPath = []
    this.poseAt = -Infinity
    for (const e of this.previewMarkers) this.viewer.entities.remove(e)
    this.previewMarkers = (preview?.markers ?? []).map((m, i) =>
      this.viewer.entities.add({ id: `drone-route-stop-${i}`, ...markerGraphics(m.lat, m.lon, m.label, PREVIEW_COLOUR) }),
    )
  }

  onTargetChange(listener: (t: FlyToTarget | null) => void) {
    this.targetListeners.add(listener)
    return () => void this.targetListeners.delete(listener)
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
    this.unsubscribeSource?.()
    this.cleanups.forEach((fn) => fn())
    if (!this.viewer.isDestroyed()) {
      this.viewer.camera.lookAtTransform(Matrix4.IDENTITY) // release the camera
      for (const e of [...this.parts.map((p) => p.entity), ...this.others, ...this.previewMarkers]) this.viewer.entities.remove(e)
    }
    this.hudListeners.clear()
    this.targetListeners.clear()
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

    const live = this.buffer.sample(now)
    const state = this.crashSite ? crashState(this.crashSite.site, now - this.crashSite.at, live) : live
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
    // Propellers spin while armed (not once crashed: the motors are cut), easing up and down.
    const dt = Math.min(0.1, (now - this.rotorAt) / 1000)
    this.rotorAt = now
    const spinning = state.armed && !this.crashSite
    this.rotorSpeed = Math.max(0, Math.min(1, this.rotorSpeed + (spinning ? 1 : -1) * ROTOR_SPIN_UP_PER_S * dt))
    this.rotorAngle = (this.rotorAngle + this.rotorSpeed * ROTOR_SPIN_RAD_S * dt) % (2 * Math.PI)
    const spinQ = new Quaternion()
    const local = new Quaternion()
    for (const part of this.parts) {
      Matrix4.multiplyByPoint(frame, Cartesian3.multiplyByScalar(part.offset, VISUAL_SCALE, new Cartesian3()), part.position)
      if (part.spin) {
        Quaternion.fromAxisAngle(Cartesian3.UNIT_Z, part.spin.phase + part.spin.direction * this.rotorAngle, spinQ)
        Quaternion.multiply(part.rotation, spinQ, local)
        Quaternion.multiply(bodyOrientation, local, part.orientation)
      } else Quaternion.multiply(bodyOrientation, part.rotation, part.orientation)
    }

    // Fly-to target, drawn at the drone's height so the line shows the path it will fly.
    // Computed here (not in onFrame) because Cesium reads the line's positions before preRender.
    this.hasTargetPosition = this.target !== null
    if (this.target) {
      Cartesian3.fromDegrees(this.target.lon, this.target.lat, state.altAmslM + TORONTO_GEOID_OFFSET_M, Ellipsoid.WGS84, this.targetPosition)
    }
    this.previewPath = this.preview ? previewPath(this.preview, state, this.dronePosition) : []
  }

  private onFrame() {
    if (this.destroyed) return
    const now = performance.now()
    const dt = Math.min((now - this.lastFrameAt) / 1000, 0.1)
    this.lastFrameAt = now

    this.updatePose()
    const state = this.current
    for (const part of this.parts) part.entity.show = this.hasPose
    for (const e of this.others) if (e.id !== 'drone-trail') e.show = this.hasPose
    if (!state) {
      // No data (e.g. PX4 selected but not running): clear the HUD rather than show stale numbers.
      if (now - this.lastHudAt >= HUD_INTERVAL_MS) {
        this.lastHudAt = now
        for (const listener of this.hudListeners) listener(null)
      }
      return
    }

    // Trail: a point every TRAIL_INTERVAL_MS of flight time while airborne (not while falling).
    if (!this.crashSite && state.inAir && state.timeMs - this.lastTrailAt >= TRAIL_INTERVAL_MS) {
      this.trail.push(Cartesian3.clone(this.dronePosition))
      if (this.trail.length > TRAIL_MAX_POINTS) this.trail.shift()
      this.lastTrailAt = state.timeMs
    }
    if (!this.crashSite && state.timeMs < this.lastTrailAt) this.clearTrail() // source restarted

    this.updateCamera(state, dt)

    if (this.target) {
      const remaining = distanceM(state.lon, state.lat, this.target.lon, this.target.lat)
      if (remaining < TARGET_REACHED_M && state.groundSpeedMs < 1) this.setTarget(null)
    }

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

  /** Chase camera: orbit the drone at the user's offset, swinging round as it turns. */
  private updateCamera(state: DroneState, dt: number) {
    const camera = this.viewer.camera
    const frame = Transforms.eastNorthUpToFixedFrame(this.dronePosition)

    if (!this.orbit) {
      // First view: behind and a little above the drone.
      camera.cancelFlight()
      this.orbitHeadingDeg = state.headingDeg
      const h = CesiumMath.toRadians(state.headingDeg)
      const p = CesiumMath.toRadians(-CHASE_PITCH_DEG)
      const flat = CHASE_RANGE_M * Math.cos(p)
      this.orbit = new Cartesian3(-Math.sin(h) * flat, -Math.cos(h) * flat, CHASE_RANGE_M * Math.sin(p))
    } else {
      // Keep whatever angle/zoom the user has dragged to (camera.position is in the drone's local frame)…
      if (!Matrix4.equals(camera.transform, Matrix4.IDENTITY)) Cartesian3.clone(camera.position, this.orbit)
      // …and turn it with the drone, smoothly, so the view stays behind it.
      const heading = lerpAngleDeg(this.orbitHeadingDeg, state.headingDeg, 1 - Math.exp(-dt * 2.5))
      const delta = CesiumMath.toRadians(((((heading - this.orbitHeadingDeg) % 360) + 540) % 360) - 180)
      this.orbitHeadingDeg = heading
      if (delta !== 0) {
        // Compass headings turn clockwise, i.e. negative about the local up axis.
        const { x, y } = this.orbit
        this.orbit.x = x * Math.cos(delta) + y * Math.sin(delta)
        this.orbit.y = -x * Math.sin(delta) + y * Math.cos(delta)
      }
    }
    camera.lookAtTransform(frame, this.orbit)
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

  /**
   * A small X-frame quadcopter, in the drone's local frame (x forward, y left, z up;
   * metres before VISUAL_SCALE): a rounded shell on a dark body, battery underneath, a
   * camera at the front, carbon arms, motors and two-blade propellers, and landing skids.
   * Front propellers and motor caps are red, back ones light, so the heading reads from
   * any angle. The propellers spin while armed, with a faint disc as motion blur.
   */
  private buildModel() {
    const s = VISUAL_SCALE
    const css = (c: string, a = 1) => Color.fromCssColorString(c).withAlpha(a)
    const box = (x: number, y: number, z: number, material: Color) => ({
      box: { dimensions: new Cartesian3(x * s, y * s, z * s), material },
    })
    const disc = (radius: number, length: number, material: Color | ColorMaterialProperty) => ({
      cylinder: { length: length * s, topRadius: radius * s, bottomRadius: radius * s, material },
    })
    const yaw = (deg: number) => Quaternion.fromAxisAngle(Cartesian3.UNIT_Z, CesiumMath.toRadians(deg))
    const pitch = (deg: number) => Quaternion.fromAxisAngle(Cartesian3.UNIT_Y, CesiumMath.toRadians(deg))
    const at = (x: number, y: number, z: number) => new Cartesian3(x, y, z)
    const I = Quaternion.IDENTITY

    // Body: dark core, rounded shell on top, battery underneath.
    this.addPart('drone-body', at(0, 0, 0), I, box(0.2, 0.11, 0.045, css('#24272c')))
    this.addPart('drone-shell', at(0.005, 0, 0.022), I, {
      ellipsoid: { radii: new Cartesian3(0.115 * s, 0.065 * s, 0.03 * s), material: css('#4a505a') },
    })
    this.addPart('drone-stripe', at(0.02, 0, 0.051), I, box(0.1, 0.012, 0.006, css('#ff9f1c')))
    this.addPart('drone-battery', at(-0.01, 0, -0.033), I, box(0.13, 0.07, 0.022, css('#3a6ea5')))

    // Camera on a small mount at the front, lens facing forward.
    this.addPart('drone-camera', at(0.115, 0, -0.02), I, box(0.03, 0.04, 0.03, css('#15171a')))
    this.addPart('drone-lens', at(0.132, 0, -0.02), pitch(90), disc(0.011, 0.006, css('#5ec8ff')))

    // Arms out to the four motors (X frame).
    const r = 0.163
    for (const [id, deg] of [['drone-arm-a', 45], ['drone-arm-b', -45]] as const) {
      this.addPart(id, at(0, 0, 0.008), yaw(deg), box(0.46, 0.022, 0.016, css('#1b1d20')))
    }

    // Motors, caps and propellers. Diagonal pairs turn the same way (front-left and
    // back-right clockwise, the others anticlockwise), as on a real quad.
    const blur = (colour: string) =>
      new ColorMaterialProperty(new CallbackProperty(() => css(colour, 0.22 * this.rotorSpeed), false))
    for (const [name, x, y, colour, direction, phase] of [
      ['fl', r, r, '#e63946', -1, 0],
      ['fr', r, -r, '#e63946', 1, 45],
      ['bl', -r, r, '#d9dde3', 1, 90],
      ['br', -r, -r, '#d9dde3', -1, 135],
    ] as const) {
      this.addPart(`drone-motor-${name}`, at(x, y, 0.022), I, disc(0.02, 0.03, css('#9aa0a6')))
      this.addPart(`drone-cap-${name}`, at(x, y, 0.04), I, disc(0.011, 0.008, css(colour)))
      this.addPart(`drone-prop-${name}`, at(x, y, 0.046), I, box(0.19, 0.02, 0.004, css(colour, 0.95)), {
        direction,
        phase: CesiumMath.toRadians(phase),
      })
      this.addPart(`drone-blur-${name}`, at(x, y, 0.046), I, disc(0.095, 0.002, blur(colour)))
    }

    // Landing skids: two legs each side down to a rail.
    for (const side of [1, -1] as const) {
      for (const x of [0.05, -0.05]) {
        this.addPart(`drone-leg-${side}-${x}`, at(x, side * 0.05, -0.05), I, box(0.008, 0.008, 0.04, css('#1b1d20')))
      }
      this.addPart(`drone-skid-${side}`, at(0, side * 0.05, -0.071), I, box(0.17, 0.01, 0.008, css('#1b1d20')))
    }
  }

  private addPart(
    id: string,
    offset: Cartesian3,
    rotation: Quaternion,
    graphics: Pick<Entity.ConstructorOptions, 'box' | 'cylinder' | 'ellipsoid'>,
    spin?: Part['spin'],
  ) {
    const part: Part = {
      entity: undefined as unknown as Entity,
      offset,
      rotation,
      spin,
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
    // Fly-to destination: a ring on the ground plus a dashed line from the drone (blue).
    this.addTargetOverlay(
      'drone-target',
      '#4cc9f0',
      () => this.target,
      () => (this.hasTargetPosition ? [this.dronePosition, this.targetPosition] : []),
      'Fly to',
    )
    // A planned route: grey markers (see setPreview) and a dashed line along the path it will fly.
    this.others.push(
      entities.add({
        id: 'drone-route-preview-line',
        polyline: {
          positions: new CallbackProperty(() => (this.poseFor() ? this.previewPath : []), false),
          width: 2,
          material: new PolylineDashMaterialProperty({ color: Color.fromCssColorString(PREVIEW_COLOUR), dashLength: 16 }),
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

  /** A destination ring + label on the ground, and a dashed line from the drone to it at the drone's height. */
  private addTargetOverlay(
    id: string,
    css: string,
    get: () => FlyToTarget | null,
    linePositions: () => Cartesian3[],
    prefix: string,
  ) {
    const colour = Color.fromCssColorString(css)
    const entities = this.viewer.entities
    const marker = markerGraphics(0, 0, '', css)
    this.others.push(
      entities.add({
        id,
        position: new CallbackPositionProperty(() => {
          const t = get()
          return t ? Cartesian3.fromDegrees(t.lon, t.lat) : undefined
        }, false),
        point: marker.point,
        label: {
          ...marker.label,
          text: new CallbackProperty(() => {
            const t = get()
            return t ? `${prefix}: ${t.label}` : ''
          }, false),
        },
      }),
      entities.add({
        id: `${id}-line`,
        polyline: {
          positions: new CallbackProperty(() => (this.poseFor() && get() ? linePositions() : []), false),
          width: 2,
          material: new PolylineDashMaterialProperty({ color: colour, dashLength: 16 }),
        },
      }),
    )
  }
}

/** A planned route's path for this frame, from the drone (or its first point) through each point. */
function previewPath(p: RoutePreview, state: DroneState, dronePosition: Cartesian3): Cartesian3[] {
  const toCartesian = (pt: PreviewPoint) =>
    'atDrone' in pt
      ? Cartesian3.fromDegrees(state.lon, state.lat, state.home.altAmslM + pt.relAltM + TORONTO_GEOID_OFFSET_M)
      : Cartesian3.fromDegrees(pt.lon, pt.lat, state.home.altAmslM + pt.relAltM + TORONTO_GEOID_OFFSET_M)
  const path = p.path.map(toCartesian)
  return p.fromDrone ? [Cartesian3.clone(dronePosition), ...path] : path
}

/** A ring on the ground with a label above it (fly-to target, route stops). */
function markerGraphics(lat: number, lon: number, label: string, css: string) {
  const colour = Color.fromCssColorString(css)
  return {
    position: Cartesian3.fromDegrees(lon, lat),
    point: {
      pixelSize: 16,
      color: colour.withAlpha(0.25),
      outlineColor: colour,
      outlineWidth: 3,
      heightReference: HeightReference.CLAMP_TO_GROUND,
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
    },
    label: {
      text: label,
      font: '600 13px system-ui, sans-serif',
      fillColor: Color.WHITE,
      outlineColor: Color.fromCssColorString('#1d1d1f'),
      outlineWidth: 3,
      style: LabelStyle.FILL_AND_OUTLINE,
      verticalOrigin: VerticalOrigin.BOTTOM,
      pixelOffset: new Cartesian2(0, -14),
      heightReference: HeightReference.CLAMP_TO_GROUND,
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
    },
  }
}
