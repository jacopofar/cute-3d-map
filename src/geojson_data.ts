import {MercatorCoordinate} from "maplibre-gl";
import type {LngLatLike} from "maplibre-gl";

import * as THREE from 'three';


const myGeoJSON = {
  "type": "FeatureCollection",
  "generator": "overpass-turbo",
  "copyright": "The data included in this document is from www.openstreetmap.org. The data is made available under ODbL.",
  "timestamp": "2025-06-09T15:44:00Z",
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
    }
  ]
};

export function heartMesh(): THREE.Mesh{
    const heartShape = new THREE.Shape();

    heartShape.moveTo( 25, 25 );
    heartShape.bezierCurveTo( 25, 25, 20, 0, 0, 0 );
    heartShape.bezierCurveTo( - 30, 0, - 30, 35, - 30, 35 );
    heartShape.bezierCurveTo( - 30, 55, - 10, 77, 25, 95 );
    heartShape.bezierCurveTo( 60, 77, 80, 55, 80, 35 );
    heartShape.bezierCurveTo( 80, 35, 80, 0, 50, 0 );
    heartShape.bezierCurveTo( 35, 0, 25, 25, 25, 25 );

    const extrudeSettings = {
        depth: 6,
        bevelEnabled: false,
        bevelSegments: 40,
        steps: 4,
        bevelSize: 1,
        bevelThickness: 8
    };

    const geometry = new THREE.ExtrudeGeometry( heartShape, extrudeSettings );

    const mesh = new THREE.Mesh( geometry, new THREE.MeshPhongMaterial({wireframe: true}) );
    return mesh;
}

const magicFactor = 300;

function toMeters(coord: [number, number], origin: [number, number], scale: number): [number, number] {
  return [(coord[0] - origin[0]) / (scale * magicFactor), (coord[1] - origin[1]) / (scale * magicFactor)]
}

export function meshesAt(viewOrigin: [number, number], scale: number): THREE.Mesh[] {
  let retVal:  THREE.Mesh[] = myGeoJSON.features.map(f => {
    const coords = f.geometry.coordinates[0];
    const baseCoord: [number, number] = [coords[0][0], coords[0][1]];
    const featureBaseShape = new THREE.Shape();
    const polyPoints: [number, number][] = [];
    polyPoints.push(toMeters(baseCoord, viewOrigin, scale))
    for(let c of coords){
      polyPoints.push(toMeters([c[0], c[1]], viewOrigin, scale))
    }
    console.log(polyPoints);
    for(let p of polyPoints){
      featureBaseShape.lineTo(p[0], p[1])
    }

    const extrudeSettings = {
        depth: 2,
        bevelEnabled: false,
    };

    const geometry = new THREE.ExtrudeGeometry(featureBaseShape, extrudeSettings );

    const mesh = new THREE.Mesh( geometry, new THREE.MeshPhongMaterial() );
    return mesh;
  })
  return retVal;
}