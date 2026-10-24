# Contributing to Slop Toronto

Thanks for wanting to make Toronto better! Everything is welcome: new landmarks, missing streets, better cars, sounds, performance work, bug reports, or just telling us that your street looks wrong.

## Run it locally

There is no build step. The page is plain ES modules and loads three.js from a CDN, so any static file server works:

```sh
git clone https://github.com/aalghooneh/slop-toronto.git
cd slop-toronto
python3 -m http.server 8000      # or: npx serve .
```

Then open <http://localhost:8000> in a browser with WebGPU (recent Chrome or Edge are the safest bet; others fall back to WebGL2).

## Run the tests

Tests use Node's built-in runner (Node 20 or newer), no install needed:

```sh
node --test tests/*.test.*
```

They also run automatically on every pull request.

## Where things live

| Path | What it does |
| --- | --- |
| `js/main.js` | Boots the scene, renderer and game loop |
| `js/toronto-geodata.js` | The city's geography (generated, don't edit by hand) |
| `js/buildings.js`, `js/towers.js`, `js/landmarks.js` | Generic blocks, the real skyline, and hand-modelled landmarks |
| `js/road-network.js`, `js/road-paint.js`, `js/expressways.js` | Streets, markings, the Gardiner and the DVP |
| `js/traffic.js`, `js/streetcars.js`, `js/pedestrians.js` | Cars, TTC streetcars and people |
| `js/controllers.js`, `js/cameras.js` | Walking, driving, cycling, flying, and the cameras |
| `tools/` | Scripts that turn OpenStreetMap data into `js/toronto-geodata.js` |

## Updating the map data

```sh
tools/fetch-geodata.sh                                             # refresh tools/data/ (Overpass API)
GEO_DATA=tools/data node --max-old-space-size=8192 tools/build-geodata.mjs
```

Commit the regenerated `js/toronto-geodata.js` together with the tool change that caused it.

## Making a pull request

1. Fork the repo and create a branch.
2. Keep each pull request to one idea; small ones get merged fastest.
3. Run the tests.
4. For anything visual, add a screenshot or short clip to the pull request. It's the quickest way to get it reviewed.

## Data and licensing

Code is MIT licensed, and by contributing you agree your contribution is too. Only use data and imagery you are allowed to redistribute: OpenStreetMap, City of Toronto Open Data, or your own work. **Do not copy Google Maps, Street View or Google Earth imagery or models**; their terms don't allow it. Looking at them for reference and modelling things yourself is fine.

## Be nice

Everyone here is doing this for fun. See the [Code of Conduct](CODE_OF_CONDUCT.md).
