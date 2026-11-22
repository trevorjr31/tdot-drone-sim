import { useEffect, useRef, useState } from 'react'
import { loadMassingIndex, loadMassingTile } from '../data/torontoData'
import { BuildingCollider, buildingName, findImpact } from './collision'
import type { CrashSite } from './crash'
import type { DroneSource, DroneState } from './types'

export type CollisionInfo = {
  /** False if the massing data couldn't be loaded (collisions are off). */
  available: boolean
  /** Distance to the nearest building at the drone's height, within 60 m; null if none. */
  nearestM: number | null
  /** The drone is inside (or touching) a building right now. */
  colliding: boolean
  /** Show the collision warning: while colliding and for a few seconds after. */
  warning: boolean
  /** Roof height of the building last hit, metres above sea level. */
  lastHitRoofM: number | null
  /** The building directly below the drone (tallest, if footprints overlap); null over open ground. */
  below: { name: string | null; heightM: number } | null
}

const UI_UPDATE_MS = 200
/**
 * How close to a City massing wall counts as hitting it. Covers half the drawn drone
 * (it's shown 4× size, ~2 m across) plus the usual 1–2 m difference between the City
 * footprints and Google's 3D buildings, so the wreck never ends up inside Google's walls.
 */
const COLLISION_MARGIN_M = 2.5
/** Keep the collision warning up this long after leaving the building. */
const WARNING_LINGER_MS = 5000

/**
 * Checks every drone state against nearby City massing buildings. Calls `onHit`
 * once each time the drone hits a building while airborne, with the impact point:
 * where its path met the wall, so it can be drawn there and never inside.
 * Paused while `enabled` is false (e.g. after a crash, until reset).
 */
export function useCollisions(source: DroneSource, onHit: (site: CrashSite) => void, enabled = true): CollisionInfo {
  const [info, setInfo] = useState<CollisionInfo>({
    available: true,
    nearestM: null,
    colliding: false,
    warning: false,
    lastHitRoofM: null,
    below: null,
  })
  const colliderRef = useRef<BuildingCollider | null>(null)
  const onHitRef = useRef(onHit)
  const enabledRef = useRef(enabled)
  useEffect(() => {
    onHitRef.current = onHit
    enabledRef.current = enabled
  }, [onHit, enabled])

  useEffect(() => {
    let cancelled = false
    loadMassingIndex()
      .then((index) => {
        if (!cancelled) colliderRef.current = new BuildingCollider(index, loadMassingTile)
      })
      .catch((err: unknown) => {
        console.warn('Building collisions off: massing data unavailable', err)
        if (!cancelled) setInfo((i) => ({ ...i, available: false }))
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    let colliding = false
    let lastUi = 0
    let lingerTimer: number | undefined
    let previous: DroneState | null = null
    const unsubscribe = source.subscribe((s) => {
      const collider = colliderRef.current
      const before = previous
      previous = s
      if (!collider || !enabledRef.current) {
        colliding = false
        return
      }
      collider.setPosition(s.lon, s.lat)
      const r = collider.check(s.lon, s.lat, s.altAmslM, { marginM: COLLISION_MARGIN_M })
      const hit = s.inAir && r.hit !== null
      const now = performance.now()

      if (hit && !colliding && r.hit) {
        const isHit = (p: { lon: number; lat: number; altAmslM: number }) =>
          collider.check(p.lon, p.lat, p.altAmslM, { marginM: COLLISION_MARGIN_M }).hit !== null
        const impact = before ? findImpact(before, s, isHit) : s
        onHitRef.current({
          lat: impact.lat,
          lon: impact.lon,
          altAmslM: impact.altAmslM,
          groundAmslM: r.hit.groundM, // street level at the foot of the building
          headingDeg: s.headingDeg,
        })
        window.clearTimeout(lingerTimer)
        const roof = r.hit?.roofM ?? null
        setInfo((i) => ({ ...i, colliding: true, warning: true, nearestM: 0, lastHitRoofM: roof }))
        lastUi = now
      } else if (hit !== colliding || now - lastUi >= UI_UPDATE_MS) {
        if (!hit && colliding) {
          lingerTimer = window.setTimeout(() => setInfo((i) => (i.colliding ? i : { ...i, warning: false })), WARNING_LINGER_MS)
        }
        const under = collider.footprintsAt(s.lon, s.lat).reduce<ReturnType<typeof collider.footprintsAt>[number] | null>(
          (best, b) => (!best || b.roofM > best.roofM ? b : best),
          null,
        )
        const below = under ? { name: buildingName(under), heightM: Math.round(under.roofM - under.groundM) } : null
        setInfo((i) => ({
          ...i,
          colliding: hit,
          nearestM: r.nearest?.distanceM ?? null,
          below: i.below?.name === below?.name && i.below?.heightM === below?.heightM ? i.below : below,
        }))
        lastUi = now
      }
      colliding = hit
    })
    return () => {
      unsubscribe()
      window.clearTimeout(lingerTimer)
    }
  }, [source])

  return info
}
