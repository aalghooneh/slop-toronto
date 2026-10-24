[out:json][timeout:240];
(
  way["highway"~"^(motorway|motorway_link|trunk|trunk_link|primary|primary_link|secondary|secondary_link|tertiary|tertiary_link|unclassified|residential|living_street|service|pedestrian)$"](43.622,-79.432,43.684,-79.338);
  way["railway"~"^(rail|tram|subway|light_rail)$"](43.622,-79.432,43.684,-79.338);
);
out body geom;
