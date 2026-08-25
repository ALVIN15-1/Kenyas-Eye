# Map Credentials

How the photorealistic globe is authorized, what each route costs, and what you
give up by choosing one over the other.

- [Two routes to the same mesh](#two-routes-to-the-same-mesh)
- [Google Map Tiles API](#google-map-tiles-api)
- [Cesium ion](#cesium-ion)
- [What the ion route gives up](#what-the-ion-route-gives-up)
- [Costs](#costs)
- [Verifying your route](#verifying-your-route)
- [Caching and terms](#caching-and-terms)

---

## Two routes to the same mesh

Google's Photorealistic 3D Tiles can be reached two ways, and only one of them
needs a billing-enabled Google Cloud account.

| Route | Credential | Geocoding | Allowance |
|---|---|---|---|
| **Google Map Tiles API** | `GOOGLE_MAPS_API_KEY` | ✅ search + reverse | 1,000 root tiles/month free, then metered |
| **Cesium ion** | `CESIUM_ION_TOKEN` | ❌ unavailable | ion's free Community allowance |

CesiumJS decides between them inside `createGooglePhotorealistic3DTileset`:

```js
const key = apiOptions.key ?? GoogleMaps.defaultApiKey;
if (!defined(key)) {
  return requestCachedIonTileset(tilesetOptions);   // ← the ion route
}
```

So the fallback engages only when `GoogleMaps.defaultApiKey` is **undefined**.

> [!WARNING]
> Assigning that property **any** value — including an empty string — sends the
> request to Google. `src/mapCredentials.js` therefore reports a missing key as
> `null` rather than `''`, and `src/main.js` skips the assignment entirely on the
> ion route. That invariant is pinned by tests because breaking it would look
> like an unrelated tile error.

**A Google key wins when both are set.** It is the direct path, it uses your own
quota rather than ion's smaller allowance, and it is the only one that also
enables geocoding. Startup fails only when *neither* credential is present.

---

## Google Map Tiles API

The default and fullest route. Requires a billing-enabled Google Cloud project.

1. Create or pick a project at [console.cloud.google.com](https://console.cloud.google.com/)
2. **Enable billing** on it. Photorealistic 3D Tiles is a metered Enterprise SKU
   and will not work without a billing account, even inside the free allowance.
3. Enable **Map Tiles API** at
   [console.cloud.google.com/apis/library/tile.googleapis.com](https://console.cloud.google.com/apis/library/tile.googleapis.com)
4. Credentials → Create credentials → API key
5. `GOOGLE_MAPS_API_KEY=...` in `.env`

> [!IMPORTANT]
> Enable **Map Tiles API** (`tile.googleapis.com`), not "Maps JavaScript API" or
> "Maps SDK". Those are the top search results and sound correct, but the raw 3D
> tileset lives behind Map Tiles API only. Get it wrong and the app loads, falls
> back to the plain Cesium globe, and the console reports a rejected tileset
> request.

### Restrict and cap it

This key is injected into the browser bundle by design and is visible in
devtools. Restriction is the mitigation, not concealment.

- *API restrictions* → restrict to **Map Tiles API**
- *Application restrictions* → HTTP referrers → `http://localhost:4173/*`
- **Set a per-day quota** under APIs & Services → Map Tiles API → Quotas

The quota is *enforced*; budget alerts only notify, and hours late. At $0.006 per
billable request, a 200/day quota caps exposure near $1.20/day.

---

## Cesium ion

No card, no Google Cloud account.

1. Sign up at [cesium.com/ion/signup](https://cesium.com/ion/signup)
2. **Access Tokens** tab → use the Default Token, or **Create token**
3. `CESIUM_ION_TOKEN=...` in `.env`, leaving `GOOGLE_MAPS_API_KEY` blank

### Scope the token

The token is client-exposed, so prefer a restricted one over the default.

- **Scopes:** `assets:read`
- **Asset access:** the assets this project actually uses —

| Asset | What | Used by |
|---|---|---|
| 1 | Cesium World Terrain | `Terrain.fromWorldTerrain()` |
| 2 | Bing Maps Aerial | `bing-aerial` map stack |
| 3 | Bing Maps Aerial with Labels | `bing-labels` map stack |

The Google tileset ion serves is fetched through ion's own cached asset, so a
token with `assets:read` covers it.

Without any ion token the app falls back to keyless Re:Earth ellipsoidal terrain
— flatter, but functional.

---

## What the ion route gives up

**Geocoding.** ion resells the imagery, not Google's Geocoding API. On the ion
route:

| Feature | Status |
|---|---|
| Photorealistic 3D globe | ✅ works |
| Bundled city presets (Austin, Tokyo, …) | ✅ fixed coordinates |
| Every live data layer | ✅ unaffected |
| Search by place name | ❌ unavailable |
| Reverse geocoding (place names under the camera) | ❌ unavailable |
| Voice/agent "fly to \<place\>" for arbitrary places | ❌ needs geocoding |

Both geocoders already guarded for a missing key, so nothing throws — the
features report unavailable. Adding a Google key later takes over automatically
with no other change.

The app logs which route it took at startup:

```
[Init] Photorealistic 3D Tiles via Cesium ion (no Google Maps key set).
Place-name search and reverse geocoding are unavailable on this route,
and ion applies its own monthly root-tile allowance.
```

---

## Costs

**Only root tileset requests are billable.** Tile payloads — the actual meshes
and textures — are unmetered on both routes. Flying, zooming, and exploring are
free; roughly one billable event per page load.

| | |
|---|---|
| Google SKU | `Map Tiles API: Photorealistic 3D Tiles` (Enterprise) |
| Price | **$6.00 per 1,000**, so $0.006 each |
| Free | 1,000 calls/month |
| Default quota | 10,000 root tileset queries/day |

Because a page load is the billable unit, **reloads are what cost money** — and
this is a Vite dev server, where editing `main.js` triggers a full reload rather
than HMR.

| Usage | Loads/month | Cost |
|---|---|---|
| Casual, ~30/day | ~900 | $0 (inside free tier) |
| Normal dev, ~100/day × 20 | 2,000 | ~$6 |
| Heavy, ~500/day × 22 | 11,000 | ~$60 |
| Saturating the default quota daily | 300,000 | ~$1,620 |

Cesium ion's free Community tier includes its own monthly root-tile allowance
plus 1,000 Global Imagery sessions.

> [!NOTE]
> ion's free tier is for personal and non-commercial use, with exploratory
> commercial evaluation permitted. Upgrading is required above revenue/funding
> thresholds or for government projects. Provider pricing and terms drift —
> check the current pages before relying on any figure here.

---

## Verifying your route

```bash
GEV_URL=http://localhost:4173 EXPECT=ion npm run qa:tileset-route
```

`EXPECT` accepts `ion`, `google`, or `none`. The check asserts at the **network
layer**, because the route is invisible in the UI.

### How ion actually serves the tiles

ion does not rehost the mesh. It brokers access and hands back a Google key.
Observed against a real token, the ion route is:

```
1. api.cesium.com/v1/assets/2275207/endpoint?access_token=<your ion token>
2. tile.googleapis.com/v1/3dtiles/root.json?key=<key ION supplied>
3. tile.googleapis.com/v1/3dtiles/datasets/...        ← the tile payloads
```

Steps 2 and 3 are **identical on both routes**; the tiles come from Google's CDN
either way. Only step 1 tells them apart, which is why the QA check keys on the
ion asset request and deliberately does *not* assert that Google went
uncontacted.

> [!NOTE]
> A dummy ion token is enough to prove step 1 happens, but not that tiles arrive
> — it fails at step 1, so Google is never reached. Any check written against a
> dummy token that asserts "Google was not contacted" passes for the wrong
> reason. Verify the full path with a real token.

Or read the `[Init]` line in the browser console.

---

## Caching and terms

Google's Map Tiles API policies prohibit pre-fetching, indexing, storing, or
caching content beyond what the response headers permit, and separately prohibit
offline use, geodata extraction, and resale.

**There is no offline mode for the globe, and bulk-downloading the tileset is not
permitted at any price tier.** The tile payloads being unmetered does not make
them free to keep; the constraint is contractual, not economic.

Attribution is required while the content is displayed. The app keeps the Cesium
credit container visible in clean-view and recording modes for exactly that
reason — do not hide it.

If you want 3D geometry you own outright, Overture Maps buildings, Microsoft's
Global ML Building Footprints, and national lidar programmes (USGS 3DEP, AHN,
Environment Agency) are all bulk-downloadable under open licences.
