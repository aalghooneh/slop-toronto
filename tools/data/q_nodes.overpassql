[out:json][timeout:240];
(
  node["highway"~"^(traffic_signals|crossing|stop|bus_stop|street_lamp)$"](43.622,-79.432,43.684,-79.338);
  node["railway"~"^(subway_entrance|tram_stop|station|level_crossing|crossing)$"](43.622,-79.432,43.684,-79.338);
  node["public_transport"~"^(platform|stop_position|station)$"](43.622,-79.432,43.684,-79.338);
  node["amenity"~"^(post_box|bicycle_rental|bench|waste_basket|fountain|telephone|parking_entrance|fuel)$"](43.622,-79.432,43.684,-79.338);
  node["emergency"="fire_hydrant"](43.622,-79.432,43.684,-79.338);
  node["natural"="tree"](43.622,-79.432,43.684,-79.338);
  node["entrance"="subway"](43.622,-79.432,43.684,-79.338);
);
out body;
