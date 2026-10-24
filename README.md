# Slop Toronto

A downtown Toronto simulation built with [three.js](https://threejs.org/), WebGPURenderer, and TSL. Explore downtown — from the harbour to Bloor Street, Bathurst to the Don — on foot, by car, by bicycle, or by helicopter.

The city is built from the real geography: every street, block and park where it really is, the real skyline (every building of 40 m and up at its true outline and height), the CN Tower, the Rogers Centre, both City Halls, Union Station and the other landmarks, the elevated Gardiner Expressway, the Union Station Rail Corridor, the Toronto Islands, and the rest of the city along the lake.

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

Geographic data: © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright) (ODbL). Third-party data and dependencies retain their respective licenses.
