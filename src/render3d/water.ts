// water.ts — 청록 lowpoly 바다 평면 + 정점 흔들림 (state.wave swell 재사용) + 정점색 하늘 반사·태양 반짝임.
import * as THREE from 'three';
import { wave, weather } from '../state';
import { metersToSceneY } from './coords';

const SIZE_SCENE = 2000;  // 커버 범위 (scene unit ≈ world px, 지형 청크 반경 camera.distance(800)*2 + 여유)
const SEGMENTS = 160;
// 정점 간격 12.5 — swell 파장(2π/K_SWELL ≈ 49px)을 파장당 4 샘플로 표현.
// mid/ripple 파장(≈20/8px)은 이 간격으로는 앨리어싱되므로 3D 지오메트리엔 swell 만 쓴다.
const CELL = SIZE_SCENE / SEGMENTS;
// 2D 의 wave.*.amp 는 색 gain 단위(미터 아님) — 3D 변위용 미터 환산 계수.
// swell amp 1.25~5.0 → 0.3~1.25m. 눈높이(3.5m)·해저 정점(-5m, terrain-mesh.ts) 사이에 머문다.
const WAVE_AMP_TO_M = 0.25;
// 교차 너울: 주 너울을 40° 틀고 파장 1.5배·진폭 0.45배 — 단일 사인파 줄무늬를 깨뜨린다.
const X_ROT = 0.7, X_K = 1 / 1.5, X_AMP = 0.45, X_SPEED = 0.8;
// 하늘 반사(프레넬 근사): 거리가 멀수록(시선이 수면에 누울수록) 지평선 색으로. 근거리는 물색 유지.
const REFL_NEAR = 30, REFL_FAR = 900, REFL_MAX = 0.7;
const BASE = new THREE.Color(0x2a8f8a);

export function buildWaterMesh(): THREE.Mesh {
    var geo = new THREE.PlaneGeometry(SIZE_SCENE, SIZE_SCENE, SEGMENTS, SEGMENTS);
    geo.rotateX(-Math.PI / 2); // XZ 평면으로
    var pos = geo.attributes.position as THREE.BufferAttribute;
    geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(pos.count * 3), 3));
    // 정점별 반사 가중치는 카메라 상대 거리만의 함수 — mesh 가 카메라를 따라다니므로 1회 계산.
    var refl = new Float32Array(pos.count);
    for (var i = 0; i < pos.count; i++) {
        var d = Math.hypot(pos.getX(i), pos.getZ(i));
        var f = (d - REFL_NEAR) / (REFL_FAR - REFL_NEAR);
        f = f < 0 ? 0 : f > 1 ? 1 : f * f * (3 - 2 * f);
        refl[i] = f * REFL_MAX;
    }
    geo.userData.refl = refl;
    var mat = new THREE.MeshStandardMaterial({
        color: 0xffffff,
        vertexColors: true,
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
//
// 정점색: 물색 → 지평선색(하늘 반사) 보간 + 태양 반짝임. 반짝임은 수면 법선을 위(+Y)로 근사한
// 반사 시선과 태양 방향의 정렬도^N × 파도 위상 기반 반짝 마스크 — 저고도 태양에서 해를 향한 빛길이 생긴다.
export function updateWaterMesh(mesh: THREE.Mesh, cam: THREE.Vector3, sunDir: THREE.Vector3,
                                sunColor: THREE.Color, sunStrength: number, horizon: THREE.Color) {
    var originX = Math.round(cam.x / CELL) * CELL;
    var originZ = Math.round(cam.z / CELL) * CELL;
    mesh.position.x = originX;
    mesh.position.z = originZ;

    var geo = mesh.geometry as THREE.BufferGeometry;
    var pos = geo.attributes.position as THREE.BufferAttribute;
    var col = geo.attributes.color as THREE.BufferAttribute;
    var refl = geo.userData.refl as Float32Array;
    var wt = wave.time;
    var wsdx = wave.swell.dx, wsdy = wave.swell.dy, wss = wave.swell.speed;
    var wsaM = wave.swell.amp * WAVE_AMP_TO_M;
    var cx = Math.cos(X_ROT), sx = Math.sin(X_ROT);
    var xdx = (wsdx * cx - wsdy * sx) * X_K, xdy = (wsdx * sx + wsdy * cx) * X_K;
    var arr = pos.array as Float32Array, carr = col.array as Float32Array;

    // 태양 반짝임 강도: 낮 + 맑음 + 태양이 수평선 위
    var glint = sunDir.y > 0 ? sunStrength * (1 - weather.cloudiness * 0.85) : 0;
    var camY = cam.y, lx0 = cam.x - originX, lz0 = cam.z - originZ;
    var bR = BASE.r, bG = BASE.g, bB = BASE.b, hR = horizon.r, hG = horizon.g, hB = horizon.b;
    var sR = sunColor.r * glint, sG = sunColor.g * glint, sB = sunColor.b * glint;

    for (var i = 0; i < pos.count; i++) {
        var lx = arr[i * 3], lz = arr[i * 3 + 2];
        var wx = lx + originX, wz = lz + originZ;
        var y = metersToSceneY(
            Math.sin(wx * wsdx + wz * wsdy + wt * wss) * wsaM +
            Math.sin(wx * xdx + wz * xdy + wt * wss * X_SPEED + 1.3) * wsaM * X_AMP);
        arr[i * 3 + 1] = y;

        var f = refl[i];
        var r = bR + (hR - bR) * f, g = bG + (hG - bG) * f, b = bB + (hB - bB) * f;
        if (glint > 0) {
            // 카메라→정점 시선을 수면(+Y 법선)에 반사 = (vx, -vy, vz). 태양 방향과의 정렬도.
            var vx = lx - lx0, vy = y - camY, vz = lz - lz0;
            var inv = 1 / Math.sqrt(vx * vx + vy * vy + vz * vz);
            var al = (vx * sunDir.x - vy * sunDir.y + vz * sunDir.z) * inv;
            if (al > 0.95) {
                al = (al - 0.95) * 20; al *= al * al;              // ^3 (0.95~1 구간 재매핑)
                // 반짝 마스크: 두 사인곱이 높은 곳만 — 연속 기둥이 아니라 부서진 빛 조각들
                var sp = Math.sin(wx * 0.9 + wz * 1.3 + wt * 3.1) * Math.sin(wx * 1.7 - wz * 0.8 + wt * 2.3);
                var k = al * (sp > 0.45 ? 1.2 : 0.12);
                r += sR * k; g += sG * k; b += sB * k;
            }
        }
        carr[i * 3] = r; carr[i * 3 + 1] = g; carr[i * 3 + 2] = b;
    }
    pos.needsUpdate = true;
    col.needsUpdate = true;
    // flatShading 은 화면 미분으로 면 법선을 만들므로 computeVertexNormals 불필요.
}
