import * as THREE from 'three';

// square building with an hole, to test this kind of shape and highlight skew
// import myGeoJSON from './bicocca_hole.json';
// in Berlin, east side
// import myGeoJSON from './lichtenberg.json';
// reichstag
// import myGeoJSON from './reichstag.json';
import myGeoJSON from './liberty_statue.json';
// import myGeoJSON from './capetown_lighthouse.json';
// import myGeoJSON from './montevideo_stadium_part.json';
// import myGeoJSON from './canada_far_north_building.json';
// import myGeoJSON from './tokyo_imperial_palace.json';
// import myGeoJSON from './santa_monica_rand.json';
// import myGeoJSON from './quito_colegio.json';


function epsg4326toEpsg3857(coordinates: [number, number]): [number, number] {
  let x = (coordinates[0] * 20037508.34) / 180;
  let y = Math.log(Math.tan(((90 + coordinates[1]) * Math.PI) / 360)) /
  (Math.PI / 180);
  y = (y * 20037508.34) / 180;
  return [x, y];
}

// Milan, Italy
// const scaleFactor = 0.70;
// Berlin, Germany
// const scaleFactor = 0.608;
// New York
// const scaleFactor = 0.758;
// Cape Town, SA + Montevideo
// const scaleFactor = 0.82835;
// northern Canada
// const scaleFactor = 0.549;
// Tokyo
// const scaleFactor = 0.812;
// Quito (close to Equator)
// const scaleFactor =  1.000;

function toModelCoords(coord: [number, number], origin: [number, number]): [number, number] {
  const coordMeters = epsg4326toEpsg3857(coord);
  const originMeters = epsg4326toEpsg3857(origin);
  const scaleFactor = Math.cos(2 * Math.PI * coord[1] / 360 );
  return [
    (coordMeters[0] - originMeters[0]) * scaleFactor,
    (coordMeters[1] - originMeters[1]) * scaleFactor];
}

export function meshesAt(viewOrigin: [number, number]): THREE.Mesh[] {
  return myGeoJSON.features.map(f => {
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
      depth: 80,
      bevelEnabled: false,
    };

    const geometry = new THREE.ExtrudeGeometry(featureBaseShape, extrudeSettings );

    return new THREE.Mesh( geometry, new THREE.MeshToonMaterial({color: 'red', transparent: true, opacity: 0.5}) );
  })
}