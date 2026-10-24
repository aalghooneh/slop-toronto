[out:json][timeout:240];
(
  way["leisure"~"^(park|garden|pitch|playground|dog_park|common|recreation_ground|stadium)$"](43.615,-79.440,43.690,-79.330);
  relation["leisure"~"^(park|garden|common|recreation_ground)$"](43.615,-79.440,43.690,-79.330);
  way["landuse"~"^(grass|recreation_ground|village_green|cemetery|forest|meadow|railway)$"](43.615,-79.440,43.690,-79.330);
  relation["landuse"~"^(grass|recreation_ground|cemetery|forest|railway)$"](43.615,-79.440,43.690,-79.330);
  way["natural"~"^(water|wood|scrub|beach|sand)$"](43.600,-79.440,43.690,-79.330);
  relation["natural"~"^(water|wood)$"](43.600,-79.440,43.690,-79.330);
  way["amenity"="parking"](43.622,-79.432,43.684,-79.338);
);
out body geom;
