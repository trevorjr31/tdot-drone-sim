import { Cesium3DTileset, createGooglePhotorealistic3DTileset, IonResource } from 'cesium'

// Cesium ion's copy of Google Photorealistic 3D Tiles.
const GOOGLE_PHOTOREALISTIC_ION_ASSET_ID = 2275207

// Same tuning Cesium's helper applies: a large tile cache so the city doesn't
// reload constantly, and collision so the camera can't go through buildings.
const tilesetOptions = {
  cacheBytes: 1536 * 1024 * 1024,
  maximumCacheOverflowBytes: 1024 * 1024 * 1024,
  enableCollision: true,
}

/**
 * Loads Google Photorealistic 3D Tiles, straight from Google when a key is given,
 * otherwise through Cesium ion.
 *
 * We don't use createGooglePhotorealistic3DTileset for the ion path because it
 * reuses one cached IonResource for every call. When two viewers load at the same
 * time (React StrictMode does this in dev), the second call fails with
 * "The Resource is already being fetched."
 */
export async function loadPhotorealisticTiles(googleApiKey?: string): Promise<Cesium3DTileset> {
  if (googleApiKey) {
    // Google's terms only allow the Google geocoder with these tiles; the app uses none.
    return createGooglePhotorealistic3DTileset({ key: googleApiKey, onlyUsingWithGoogleGeocoder: true }, { ...tilesetOptions })
  }
  const resource = await IonResource.fromAssetId(GOOGLE_PHOTOREALISTIC_ION_ASSET_ID)
  return Cesium3DTileset.fromUrl(resource, { ...tilesetOptions })
}
