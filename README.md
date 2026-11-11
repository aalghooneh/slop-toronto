# Slop Toronto

A downtown Toronto simulation built with [three.js](https://threejs.org/), WebGPURenderer, and TSL. Explore downtown — from the harbour to Bloor Street, Bathurst to the Don — on foot, by car, by bicycle, or by helicopter.

[Try it live](https://aalghooneh.github.io/slop-toronto/) · Works best in a browser with WebGPU (recent Chrome or Edge).

The city is built from the real geography: every street, block and park where it really is, the real skyline (every building of 40 m and up at its true outline and height), the CN Tower, the Rogers Centre, both City Halls, Union Station and the other landmarks, the elevated Gardiner Expressway, the Union Station Rail Corridor, the Toronto Islands, and the rest of the city along the lake.

## Toronto Hustle

There is a game to play on the city. Every way of getting about has its own work, and cash earns ranks:

- **Drive: cab fares.** Stop in a yellow beacon, then get your fare where they're going before their patience runs out. Every fare is somebody (in a hurry, easygoing, a thrill-seeker, nervous) and tips accordingly. Drifts, near misses and flat-out runs pay on the side.
- **Cycle: courier runs.** Collect an order at an orange beacon and deliver it while it's hot.
- **Fly: skyline tours.** Thread the rings hung by the landmarks against the clock.
- **Walk: the raccoon hunt.** Forty raccoons are raiding green bins all over downtown.

The way there is routed along the real streets (one-ways included) and drawn on the road, the radar and the map. `G` turns the gigs on and off, `R` repairs the car, `T` steps through the weather: clear, rain (wet roads, less grip) and snow (which settles on the whole city).

The car drives on a tyre model (`js/controllers.js`, `carHandling`): weight shifts under braking and power, the tyres give way past about 8° of slip, the handbrake locks the rear, and stability control keeps it pointing where it's going unless you floor it with `Shift`.

## Help build it

This is an open project and it gets better with every Torontonian who touches it. You don't need to be a 3D expert: if you know the city, you can help.

- **Spotted something wrong?** A missing street, a building in the wrong place, the wrong colour streetcar: [open an issue](https://github.com/aalghooneh/slop-toronto/issues/new/choose).
- **Want to build something?** Pick an idea below or bring your own, then read [CONTRIBUTING.md](CONTRIBUTING.md). There's no build step, so you can be running it locally in a minute.

Ideas we'd love help with:

- Real shapes and heights for every downtown building, from the City of Toronto's 3D massing model
- Building colours, materials and roof shapes from OpenStreetMap
- More landmarks: Casa Loma, the ROM, the AGO, St. Lawrence Market, the Distillery District, Honest Ed's sign
- GO trains and the UP Express on the rail corridor
- A rideable Toronto Island ferry
- A walkable PATH network underground
- Raccoons

## Make it your own

Fork it, remix it, improve it, break it. Make games, animations, films, experiments, or something completely different. Use it as a starting point and take it wherever you want. Have fun!

## The geography

`js/toronto-geodata.js` is generated from OpenStreetMap:

```sh
tools/fetch-geodata.sh                                             # refresh tools/data/ (Overpass API)
GEO_DATA=tools/data node --max-old-space-size=8192 tools/build-geodata.mjs
```

## The colours

The brick, stone and glass colours were measured from about 430 freely licensed photos of Toronto on Wikimedia
Commons. The photos aren't in this repo, only the colours taken from them (`tools/data/commons_palette.json`), and
every photo used is credited in [`tools/data/commons_photos.md`](tools/data/commons_photos.md). To measure them again
(needs Python with Pillow and numpy):

```sh
python3 -I tools/commons-palette.py
```

Adding categories to `GROUPS` in that script (say, a neighbourhood's photos) is an easy way to help.

## License and data

The project code is available under the [MIT License](LICENSE).

This project started as a fork of [mrdoob/slop-newyork](https://github.com/mrdoob/slop-newyork).

The player's car is three.js's example model, "Ferrari 458 Italia" by [vicent091036](https://sketchfab.com/models/57bf6cc56931426e87494f554df1dab6) (`assets/ferrari.glb`); it keeps its author's licence, not this project's.

Geographic data: © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright) (ODbL). Facade colours
measured from Wikimedia Commons photos, credited in [`tools/data/commons_photos.md`](tools/data/commons_photos.md). Third-party data and dependencies retain their respective licenses.
