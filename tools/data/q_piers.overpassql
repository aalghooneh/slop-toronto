[out:json][timeout:180];
(
  way["man_made"~"^(pier|breakwater|quay|groyne)$"](43.600,-79.440,43.650,-79.330);
  relation["man_made"~"^(pier|breakwater)$"](43.600,-79.440,43.650,-79.330);
  way["aeroway"~"^(runway|taxiway|apron|terminal)$"](43.620,-79.410,43.640,-79.385);
);
out body geom;
