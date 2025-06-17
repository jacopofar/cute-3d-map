import * as THREE from 'three';

// square building with an hole, to test this kind of shape and highlight skew
const myGeoJSON = {
  "type": "FeatureCollection",
  "generator": "overpass-turbo",
  "copyright": "The data included in this document is from www.openstreetmap.org. The data is made available under ODbL.",
  "timestamp": "2025-06-17T13:10:02Z",
  "features": [
    {
      "type": "Feature",
      "properties": {
        "@id": "relation/6827405",
        "building": "apartments",
        "building:levels": "4",
        "roof:colour": "#c67164",
        "type": "multipolygon"
      },
      "geometry": {
        "type": "Polygon",
        "coordinates": [
          [
            [
              9.1984229,
              45.4993129
            ],
            [
              9.1985991,
              45.4996229
            ],
            [
              9.1980964,
              45.4997633
            ],
            [
              9.1979201,
              45.4994534
            ],
            [
              9.1981346,
              45.4993935
            ],
            [
              9.1984229,
              45.4993129
            ]
          ],
          [
            [
              9.1984122,
              45.4995659
            ],
            [
              9.1983402,
              45.4994391
            ],
            [
              9.1981002,
              45.4995061
            ],
            [
              9.1981722,
              45.4996329
            ],
            [
              9.1984122,
              45.4995659
            ]
          ]
        ]
      },
      "id": "relation/6827405"
    }
  ]
};

// asymmetrical building, to check overlapping with map and orientation
const myGeoJSON2 = {
  "type": "FeatureCollection",
  "generator": "overpass-turbo",
  "copyright": "The data included in this document is from www.openstreetmap.org. The data is made available under ODbL.",
  "timestamp": "2025-06-17T13:10:02Z",
  "features": [
    {
      "type": "Feature",
      "properties": {
        "@id": "way/165079765",
        "building": "apartments",
        "building:colour": "#bbb6ae",
        "building:levels": "5",
        "building:material": "concrete",
        "roof:colour": "#c5817a",
        "roof:levels": "0",
        "roof:shape": "hipped"
      },
      "geometry": {
        "type": "Polygon",
        "coordinates": [
          [
            [
              9.2018389,
              45.5092296
            ],
            [
              9.2014586,
              45.5093449
            ],
            [
              9.2014452,
              45.5093232
            ],
            [
              9.2014169,
              45.5093317
            ],
            [
              9.2013656,
              45.5092485
            ],
            [
              9.2015175,
              45.5092025
            ],
            [
              9.201525,
              45.5092147
            ],
            [
              9.2016655,
              45.5091722
            ],
            [
              9.2013634,
              45.5086815
            ],
            [
              9.2013289,
              45.508692
            ],
            [
              9.2013175,
              45.5086744
            ],
            [
              9.201253,
              45.508694
            ],
            [
              9.2012758,
              45.5087282
            ],
            [
              9.2012551,
              45.5087349
            ],
            [
              9.2015112,
              45.5091355
            ],
            [
              9.2013482,
              45.5091852
            ],
            [
              9.2011322,
              45.5088384
            ],
            [
              9.2010758,
              45.5088558
            ],
            [
              9.2010341,
              45.5087917
            ],
            [
              9.2009552,
              45.5088178
            ],
            [
              9.2009054,
              45.5087441
            ],
            [
              9.2010059,
              45.5087107
            ],
            [
              9.2010126,
              45.5087205
            ],
            [
              9.2012271,
              45.5086521
            ],
            [
              9.2012171,
              45.5086354
            ],
            [
              9.20128,
              45.5086145
            ],
            [
              9.2012937,
              45.5086364
            ],
            [
              9.2014437,
              45.5085896
            ],
            [
              9.2017759,
              45.5091275
            ],
            [
              9.2018389,
              45.5092296
            ]
          ]
        ]
      },
      "id": "way/165079765"
    }]};


    function epsg4326toEpsg3857(coordinates: [number, number]): [number, number] {
      let x = (coordinates[0] * 20037508.34) / 180;
      let y = Math.log(Math.tan(((90 + coordinates[1]) * Math.PI) / 360)) /
      (Math.PI / 180);
      y = (y * 20037508.34) / 180;
      return [x, y];
    }

    function toModelCoords(coord: [number, number], origin: [number, number]): [number, number] {
      const coordMeters = epsg4326toEpsg3857(coord);
      const originMeters = epsg4326toEpsg3857(origin);
      // for myGeoJSON2 shou;ld be around [1200, 1300], they are currently around [1700, 1800]
      return [(coordMeters[0] - originMeters[0]), (coordMeters[1] - originMeters[1])];
    }

    export function meshesAt(viewOrigin: [number, number]): THREE.Mesh[] {
      return myGeoJSON2.features.map(f => {
        const coords = f.geometry.coordinates[0];
        const polyPoints: [number, number][] = coords.map(c => toModelCoords([c[0], c[1]], viewOrigin))
        // console.log(polyPoints);

        const featureBaseShape = new THREE.Shape(polyPoints.map(pp => new THREE.Vector2(pp[0], pp[1])));
        console.log("Outer points:", [...featureBaseShape.getPoints().map(p => [p.x, p.y])])
        // now the holes, if any
        for(let hi=1; hi < f.geometry.coordinates.length; hi++){
          const holePoints = f.geometry.coordinates[hi].map(c => toModelCoords([c[0], c[1]], viewOrigin))
          featureBaseShape.holes.push(new THREE.Path(holePoints.map(pp => new THREE.Vector2(pp[0], pp[1]))))
        }
        const extrudeSettings = {
          depth: 2,
          bevelEnabled: false,
        };

        const geometry = new THREE.ExtrudeGeometry(featureBaseShape, extrudeSettings );

        return new THREE.Mesh( geometry, new THREE.MeshToonMaterial({color: 'red', transparent: true, opacity: 0.8}) );
      })
    }