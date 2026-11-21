import {
  Cartesian3,
  ClassificationType,
  Color,
  ColorMaterialProperty,
  CustomDataSource,
  PolygonHierarchy,
} from 'cesium'
import type {
  BoundaryProps,
  FeatureCollection,
  NeighbourhoodProps,
  PolygonGeometry,
  Position,
} from '../data/torontoData'

// Drape onto the Google mesh (roofs, streets) and onto the terrain globe, which
// is what shows when the photorealistic layer is turned off. Only one of the two
// is visible at a time, so there's no double-drawing.
const DRAPE = ClassificationType.BOTH

/** Splits Polygon / MultiPolygon into a list of polygons, each [outerRing, ...holes]. */
function polygonsOf(geometry: PolygonGeometry): Position[][][] {
  return geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates
}

function ringToCartesians(ring: Position[]): Cartesian3[] {
  return Cartesian3.fromDegreesArray(ring.flatMap(([lon, lat]) => [lon, lat]))
}

function hierarchyOf([outer, ...holes]: Position[][]): PolygonHierarchy {
  return new PolygonHierarchy(
    ringToCartesians(outer),
    holes.map((h) => new PolygonHierarchy(ringToCartesians(h))),
  )
}

/** Stable, well-spread colour per neighbourhood number (golden-angle hues). */
function colourFor(id: string): Color {
  const n = Number.parseInt(id, 10) || 0
  const hue = ((n * 137.508) % 360) / 360
  return Color.fromHsl(hue, 0.7, 0.55)
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}

export function createBoundaryLayer(data: FeatureCollection<BoundaryProps>): CustomDataSource {
  const source = new CustomDataSource('City of Toronto boundary')
  for (const feature of data.features) {
    for (const [outer] of polygonsOf(feature.geometry)) {
      source.entities.add({
        name: feature.properties.name,
        polyline: {
          positions: ringToCartesians(outer),
          clampToGround: true,
          classificationType: DRAPE,
          width: 5,
          material: Color.fromCssColorString('#ffd166'),
        },
      })
    }
  }
  return source
}

export function createNeighbourhoodsLayer(data: FeatureCollection<NeighbourhoodProps>): CustomDataSource {
  const source = new CustomDataSource('Neighbourhoods')
  for (const feature of data.features) {
    const { id, name, classification } = feature.properties
    const colour = colourFor(id)
    const description = `
      <table class="cesium-infoBox-defaultTable"><tbody>
        <tr><th>Neighbourhood</th><td>${escapeHtml(name)}</td></tr>
        <tr><th>Number</th><td>${escapeHtml(id)}</td></tr>
        <tr><th>Classification</th><td>${escapeHtml(classification)}</td></tr>
      </tbody></table>`

    polygonsOf(feature.geometry).forEach((rings, i) => {
      // Translucent fill, clickable, shows details in Cesium's info box.
      source.entities.add({
        id: `neighbourhood-${id}-${i}`,
        name,
        description,
        polygon: {
          hierarchy: hierarchyOf(rings),
          classificationType: DRAPE,
          material: new ColorMaterialProperty(colour.withAlpha(0.22)),
        },
      })
      // Outline. Neighbouring borders overlap, which just reads as one line.
      source.entities.add({
        id: `neighbourhood-${id}-${i}-outline`,
        name,
        description,
        polyline: {
          positions: ringToCartesians(rings[0]),
          clampToGround: true,
          classificationType: DRAPE,
          width: 2,
          material: colour.withAlpha(0.9),
        },
      })
    })
  }
  return source
}
