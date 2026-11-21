import type { DroneState } from './types'

/** Where the drone hit a building, and the ground below that point (metres above sea level). */
export type CrashSite = { lat: number; lon: number; altAmslM: number; groundAmslM: number; headingDeg: number }

const G = 9.81
/** The wreck rests this high (its centre) above the ground, lying on its side. */
export const WRECK_HEIGHT_M = 0.4

/**
 * The drone's state t ms after a crash: free fall from the impact point with a tumble,
 * then lying on its side on the ground. Other fields (battery, home…) come from the source.
 */
export function crashState(site: CrashSite, elapsedMs: number, live: DroneState | null): DroneState {
  const t = elapsedMs / 1000
  const restAlt = site.groundAmslM + WRECK_HEIGHT_M
  const fallAlt = site.altAmslM - 0.5 * G * t * t
  const landed = fallAlt <= restAlt
  const tFall = Math.sqrt(Math.max(0, (2 * (site.altAmslM - restAlt)) / G))
  const tt = landed ? tFall : t // tumble stops when it lands
  const home = live?.home ?? { lat: site.lat, lon: site.lon, altAmslM: site.groundAmslM }
  const altAmslM = landed ? restAlt : fallAlt
  return {
    timeMs: live?.timeMs ?? elapsedMs,
    lat: site.lat,
    lon: site.lon,
    altAmslM,
    relAltM: altAmslM - home.altAmslM,
    headingDeg: (((site.headingDeg + tt * 140) % 360) + 360) % 360,
    rollDeg: landed ? 82 : Math.min(85, tt * 220) * Math.sin(tt * 4 + 0.5),
    pitchDeg: landed ? 8 : 35 * Math.sin(tt * 7),
    groundSpeedMs: 0,
    climbRateMs: landed ? 0 : -G * t,
    battery: live?.battery ?? 0,
    armed: false,
    inAir: !landed,
    flightMode: 'Crashed',
    home,
  }
}
