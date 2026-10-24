#!/bin/bash
# usage: tools/fetch-geodata.sh — refreshes tools/data/osm_*.json from OpenStreetMap (Overpass API) for
# tools/build-geodata.mjs; each query file is tools/data/q_<name>.overpassql. Every download is then trimmed to the
# tags the build reads (tools/slim-osm.mjs).
set -euo pipefail
cd "$(dirname "$0")"
tags() {
  case "$1" in
    lake) echo "name,natural" ;;
    roads) echo "name,highway,railway,service,usage,oneway,lanes,width,bridge,tunnel,layer,junction,access,area" ;;
    parks) echo "name,leisure,landuse,natural,water,amenity,parking" ;;
    piers) echo "name,man_made,aeroway,ref,width" ;;
    buildings) echo "name,building,building:part,height,min_height,building:levels,building:min_level,building:colour,colour,building:material,building:facade:material,roof:shape" ;;
    nodes) echo "highway,railway,amenity,emergency,natural,public_transport,entrance,crossing,name" ;;
  esac
}
for q in lake roads parks piers buildings nodes; do
  bash overpass.sh "data/osm_$q.json" "data/q_$q.overpassql"
  node slim-osm.mjs "data/osm_$q.json" "$(tags "$q")"
done
