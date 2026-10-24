// index.ts — render3d 오케스트레이션. main.ts 에서 init3D() 1회 + Draw3D() 매 프레임 호출.
import * as THREE from 'three';
import { scene, camera3d, canvas3d, initRenderer, Render3D } from './renderer';
import { setSceneOrigin, applyCameraToThree } from './coords';
import { updateTerrainChunks } from './terrain-mesh';
import { buildWaterMesh, updateWaterMesh } from './water';
import { buildSkyDome, updateSkyDome } from './sky3d';
import { buildCelestialRig, updateCelestialRig } from './celestial';
import { boat } from '../state';

let waterMesh: THREE.Mesh;
let skyDome: THREE.Mesh;
let fog: THREE.Fog;
let rig: ReturnType<typeof buildCelestialRig>;
let initialized = false;
let initFailed = false;

// 성공 시 true. WebGL 초기화 실패 시 false (이후 재시도 안 함).
export function init3D(): boolean {
    if (initialized) return true;
    if (initFailed) return false;
    if (!initRenderer()) { initFailed = true; return false; }
    initialized = true;

    setSceneOrigin(boat.gx, boat.gy);

    fog = new THREE.Fog(0x223344, 200, 1900);
    scene.fog = fog;

    skyDome = buildSkyDome(scene);

    updateTerrainChunks(scene, boat.gx, boat.gy, Infinity); // 시작 시 렌더 거리 안 청크 전부 생성

    waterMesh = buildWaterMesh();
    scene.add(waterMesh);

    rig = buildCelestialRig(scene);
    return true;
}

// 그렸으면 true, WebGL 불가로 못 그렸으면 false.
export function Draw3D(): boolean {
    if (!init3D()) return false;
    applyCameraToThree(camera3d);
    updateTerrainChunks(scene, boat.gx, boat.gy);
    // 스카이돔/물 평면은 카메라를 따라다녀야 "무한히 펼쳐진" 하늘/바다처럼 보인다.
    // (원점 고정이면 배가 이동해 돔 경계를 벗어나는 순간 돔 밑면·바다 가장자리가 노출됨)
    // 물 평면 위치는 updateWaterMesh 가 정점 간격 단위로 스냅해 잡는다.
    skyDome.position.copy(camera3d.position);
    updateWaterMesh(waterMesh, camera3d.position.x, camera3d.position.z);
    updateSkyDome(skyDome, fog);
    updateCelestialRig(rig, camera3d.position);
    Render3D();
    return true;
}

export { canvas3d };
