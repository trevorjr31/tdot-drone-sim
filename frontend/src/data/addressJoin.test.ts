import { describe, expect, it } from 'vitest'
import { joinAddresses, parseCsv, type AddressPoint, type Footprint } from './addressJoin'

/** A square footprint ~11 m on a side with its south-west corner at (lon, lat). */
function square(owner: number, lon: number, lat: number, size = 0.0001): Footprint {
  const outer = [
    [lon, lat],
    [lon + size, lat],
    [lon + size, lat + size],
    [lon, lat + size],
    [lon, lat],
  ] as Footprint['outer']
  return { owner, outer, holes: [], bbox: [lon, lat, lon + size, lat + size] }
}

const pt = (lon: number, lat: number, address: string, extra: Partial<AddressPoint> = {}): AddressPoint => ({
  lon,
  lat,
  address,
  place: null,
  ward: null,
  rank: 1,
  ...extra,
})

const LON = -79.38
const LAT = 43.65

describe('joinAddresses', () => {
  it('gives a building the addresses inside its footprint, best rank first', () => {
    const out = joinAddresses(
      [square(0, LON, LAT)],
      [
        pt(LON + 0.00005, LAT + 0.00005, '12 King St', { rank: 2 }),
        pt(LON + 0.00004, LAT + 0.00004, '10 King St', { rank: 1, place: 'King Hall', ward: 'Spadina-Fort York' }),
      ],
    )
    expect(out.get(0)).toEqual({ addresses: ['10 King St', '12 King St'], count: 2, place: 'King Hall', ward: 'Spadina-Fort York' })
  })

  it('falls back to the nearest building within reach for a point on no footprint', () => {
    // ~8 m east of building 0, ~30 m from building 1.
    const out = joinAddresses([square(0, LON, LAT), square(1, LON + 0.0005, LAT)], [pt(LON + 0.0002, LAT + 0.00005, '5 Elm St')])
    expect(out.get(0)?.addresses).toEqual(['5 Elm St'])
    expect(out.has(1)).toBe(false)
  })

  it('never lets a nearby lot point override a building that has its own address', () => {
    const out = joinAddresses([square(0, LON, LAT)], [pt(LON + 0.00005, LAT + 0.00005, '1 Own St'), pt(LON + 0.0002, LAT, 'Parkette')])
    expect(out.get(0)?.addresses).toEqual(['1 Own St'])
  })

  it('ignores points out of reach', () => {
    expect(joinAddresses([square(0, LON, LAT)], [pt(LON + 0.001, LAT, 'Far St')]).size).toBe(0)
  })

  it('keeps a few addresses but counts them all, without duplicates', () => {
    const points = [1, 2, 3, 4, 5, 6, 7, 7].map((n) => pt(LON + 0.00005, LAT + 0.00005, `${n} Bay St`))
    const j = joinAddresses([square(0, LON, LAT)], points, { keep: 3 }).get(0)
    expect(j?.addresses).toEqual(['1 Bay St', '2 Bay St', '3 Bay St'])
    expect(j?.count).toBe(7)
  })
})

describe('parseCsv', () => {
  it('handles quotes, doubled quotes, commas and CRLF', () => {
    const rows = [...parseCsv('a,b,c\r\n1,"x, y","say ""hi"""\n2,,{"k": 1}\n')]
    expect(rows).toEqual([
      ['a', 'b', 'c'],
      ['1', 'x, y', 'say "hi"'],
      ['2', '', '{"k": 1}'],
    ])
  })
})
