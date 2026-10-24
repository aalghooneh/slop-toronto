# Slop Toronto

A downtown Toronto simulation built with [three.js](https://threejs.org/), WebGPURenderer, and TSL. Explore downtown — from the harbour to Bloor Street, Bathurst to the Don — on foot, by car, by bicycle, or by helicopter.

[Try it live](https://aalghooneh.github.io/slop-toronto/) · Works best in a browser with WebGPU (recent Chrome or Edge).

The city is built from the real geography: every street, block and park where it really is, the real skyline (every building of 40 m and up at its true outline and height), the CN Tower, the Rogers Centre, both City Halls, Union Station and the other landmarks, the elevated Gardiner Expressway, the Union Station Rail Corridor, the Toronto Islands, and the rest of the city along the lake.

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

## License and data

The project code is available under the [MIT License](LICENSE).

This project started as a fork of [mrdoob/slop-newyork](https://github.com/mrdoob/slop-newyork).

Geographic data: © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright) (ODbL). Third-party data and dependencies retain their respective licenses.
