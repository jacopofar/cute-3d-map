import * as THREE from 'three';

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

const magicFactor = 300;


function toMeters(coord: [number, number], origin: [number, number], scale: number): [number, number] {
  return [(coord[0] - origin[0]) / (scale * magicFactor), (coord[1] - origin[1]) / (scale * magicFactor)];
  // this version "works" but the scale is wrong and the skew is still present
  // see https://github.com/jscastro76/threebox/blob/master/src/utils/utils.js#L103
  // const EARTH_RADIUS = 6371008.8;
  // const DEG2RAD = 3.141592 / 180;
  // const PROJECTION_WORLD_SIZE = 1024000 / (EARTH_RADIUS * Math.PI * 2);
  // return [
  // 		-EARTH_RADIUS * DEG2RAD * (coord[0] - origin[0]) * PROJECTION_WORLD_SIZE,
  // 		-EARTH_RADIUS * Math.log(Math.tan((Math.PI * 0.25) + (0.5 * DEG2RAD * (coord[1] - origin[1])))) * PROJECTION_WORLD_SIZE
  // 	];
}

export function meshesAt(viewOrigin: [number, number], scale: number): THREE.Mesh[] {
  return myGeoJSON.features.map(f => {
    const coords = f.geometry.coordinates[0];
    const polyPoints: [number, number][] = coords.map(c => toMeters([c[0], c[1]], viewOrigin, scale))
    // console.log(polyPoints);

    const featureBaseShape = new THREE.Shape(polyPoints.map(pp => new THREE.Vector2(pp[0], pp[1])));
    console.log("Outer points:", featureBaseShape.getPoints())
    // now the holes, if any
    for(let hi=1; hi < f.geometry.coordinates.length; hi++){
      const holePoints = f.geometry.coordinates[hi].map(c => toMeters([c[0], c[1]], viewOrigin, scale))
      featureBaseShape.holes.push(new THREE.Path(holePoints.map(pp => new THREE.Vector2(pp[0], pp[1]))))
    }
    const extrudeSettings = {
      depth: 2,
      bevelEnabled: false,
    };

    const geometry = new THREE.ExtrudeGeometry(featureBaseShape, extrudeSettings );

    return new THREE.Mesh( geometry, new THREE.MeshToonMaterial({color: 'red'}) );
  })
}