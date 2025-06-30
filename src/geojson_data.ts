import * as THREE from 'three';

// square building with an hole, to test this kind of shape and highlight skew
// import myGeoJSON from './bicocca_hole.json';
// in Berlin, east side
// import myGeoJSON from './lichtenberg.json';
// reichstag
// import myGeoJSON from './reichstag.json';
// import myGeoJSON from './liberty_statue.json';
// import myGeoJSON from './capetown_lighthouse.json';
// import myGeoJSON from './montevideo_stadium_part.json';
// import myGeoJSON from './canada_far_north_building.json';
// import myGeoJSON from './tokyo_imperial_palace.json';
// import myGeoJSON from './santa_monica_rand.json';
// import myGeoJSON from './quito_colegio.json';
import myGeoJSON from './milano_raw.json';


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

  function coordsToShape(coords: [number, number][][], viewOrigin: [number, number]){
    const polyPoints: [number, number][] = coords[0].map(c => toModelCoords([c[0], c[1]], viewOrigin));
    // console.log("polyPoints:", polyPoints);

    const featureBaseShape = new THREE.Shape(polyPoints.map(pp => new THREE.Vector2(pp[0], pp[1])));
    // console.log("Outer points:", [...featureBaseShape.getPoints().map(p => [p.x, p.y])])
    // now the holes, if any
    for(let hi=1; hi < coords.length; hi++){
      const holePoints = coords[hi].map(c => toModelCoords([c[0], c[1]], viewOrigin))
      featureBaseShape.holes.push(new THREE.Path(holePoints.map(pp => new THREE.Vector2(pp[0], pp[1]))))
    }
    return featureBaseShape;
  }

  function geoJSONtoMeshes(f: any, viewOrigin: [number, number]): THREE.Mesh[]{
    if (f.geometry.type !== 'Polygon' && f.geometry.type !== 'MultiPolygon'){
      return [];
    }
    if (!('building' in f.properties)){
      return [];
    }
    // console.log("to render: ", f);
    const extrudeSettings = {
      depth: 80,
      bevelEnabled: false,
    };
    if (f.geometry.type === 'MultiPolygon') {
      return f.geometry.coordinates.map((polygon: [number, number][][]) => {
        const featureBaseShape = coordsToShape(polygon, viewOrigin);

        const geometry = new THREE.ExtrudeGeometry(featureBaseShape, extrudeSettings );
        return new THREE.Mesh( geometry, new THREE.MeshToonMaterial({
          color: 'red',
          transparent: true, opacity: 0.9
        }) );
      })

    }
    else {
      if (f.geometry.type === 'Polygon') {
        const featureBaseShape = coordsToShape(f.geometry.coordinates, viewOrigin);
        const geometry = new THREE.ExtrudeGeometry(featureBaseShape, extrudeSettings );
        return [new THREE.Mesh( geometry, new THREE.MeshToonMaterial({
          color: 'red',
          transparent: true, opacity: 0.5
        }) )];

      }
    }
    console.error("Cannot handle feature:", f);
    return [];
  }

  export function meshesAt(viewOrigin: [number, number]): THREE.Mesh[] {
    return myGeoJSON.features.map(f => geoJSONtoMeshes(f, viewOrigin)).filter((m: THREE.Mesh[]) => m.length !== 0).flat(1);
  }