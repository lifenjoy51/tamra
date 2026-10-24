// water.ts — 청록 lowpoly 바다 평면 + 정점 흔들림 (state.wave swell 재사용).
import * as THREE from 'three';
import { wave } from '../state';
import { metersToSceneY } from './coords';

const SIZE_SCENE = 2000;  // 커버 범위 (scene unit ≈ world px, 지형 청크 반경 camera.distance(800)*2 + 여유)
const SEGMENTS = 160;
// 정점 간격 12.5 — swell 파장(2π/K_SWELL ≈ 49px)을 파장당 4 샘플로 표현.
// mid/ripple 파장(≈20/8px)은 이 간격으로는 앨리어싱되므로 3D 지오메트리엔 swell 만 쓴다.
const CELL = SIZE_SCENE / SEGMENTS;
// 2D 의 wave.*.amp 는 색 gain 단위(미터 아님) — 3D 변위용 미터 환산 계수.
// swell amp 1.25~5.0 → 0.3~1.25m. 눈높이(3.5m)·해저 정점(-5m, terrain-mesh.ts) 사이에 머문다.
const WAVE_AMP_TO_M = 0.25;

export function buildWaterMesh(): THREE.Mesh {
    var geo = new THREE.PlaneGeometry(SIZE_SCENE, SIZE_SCENE, SEGMENTS, SEGMENTS);
    geo.rotateX(-Math.PI / 2); // XZ 평면으로
    var mat = new THREE.MeshStandardMaterial({
        color: 0x2a8f8a,
        roughness: 0.35,
        metalness: 0.05,
        flatShading: true,
    });
    return new THREE.Mesh(geo, mat);
}

// mesh 는 매 프레임 카메라 바로 아래로 재배치되어 "무한한 바다"처럼 보이게 한다.
// 그 상태로 로컬 정점좌표만으로 파도 위상을 계산하면 배가 나아가도 파도가 전혀 흐르지 않아
// 이동감(시차)이 사라진다 — mesh 위치(씬 좌표)를 로컬 좌표에 더해 씬 좌표 기준으로 위상을 계산한다.
// 위치는 CELL 단위로 스냅 — 연속 이동하면 매 프레임 샘플 지점이 바뀌어 파면이 일렁인다.
export function updateWaterMesh(mesh: THREE.Mesh, camX: number, camZ: number) {
    var originX = Math.round(camX / CELL) * CELL;
    var originZ = Math.round(camZ / CELL) * CELL;
    mesh.position.x = originX;
    mesh.position.z = originZ;

    var geo = mesh.geometry as THREE.BufferGeometry;
    var pos = geo.attributes.position as THREE.BufferAttribute;
    var wt = wave.time;
    var wsdx = wave.swell.dx, wsdy = wave.swell.dy, wss = wave.swell.speed;
    var wsaM = wave.swell.amp * WAVE_AMP_TO_M;
    var arr = pos.array as Float32Array;
    for (var i = 0; i < pos.count; i++) {
        var wx = arr[i * 3] + originX;
        var wz = arr[i * 3 + 2] + originZ;
        arr[i * 3 + 1] = metersToSceneY(Math.sin(wx * wsdx + wz * wsdy + wt * wss) * wsaM);
    }
    pos.needsUpdate = true;
    // flatShading 은 화면 미분으로 면 법선을 만들므로 computeVertexNormals 불필요.
}
