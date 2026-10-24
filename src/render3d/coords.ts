// coords.ts — 월드(px/미터/라디안) ↔ three.js 씬 좌표 변환 (lowpoly PoC 전용).
// 씬 XZ평면 = 월드 픽셀 그대로 (origin 만 보트 시작 위치로 이동해 float 정밀도 확보).
// Y(높이) = heightMeters(m) / RENDER_UNIT_M(400) — 수평 스케일과 같은 실제 비율(과장 없음).
// 지구 곡률은 applyCurvature() 가 지형·바다 셰이더에서 카메라 거리²/2R 만큼 내린다.
import * as THREE from 'three';
import { RENDER_UNIT_M } from '../config';
import { camera as gcam, boat, BASE_CAM_METERS } from '../state';

// 2D voxel 렌더러는 곡률 계산 때문에 눈높이를 50m(BASE_CAM_METERS)로 고정해 쓰는데,
// 3D 는 "배 위의 사람" 실제 시점 — 선미 갑판(수면 위 ~1.1m)에 선 키잡이 눈높이.
// 배 뷰모델 카메라(boat3d.ts)도 같은 값 → 두 씬의 원근·수평선이 일치한다.
export const EYE_HEIGHT_M = 2.6;
export const CAM_PITCH = -0.05;   // 시선 살짝 아래 (≈ -3°) — 근경 바다·갑판을 더 보여줌

// 수직 과장 배수. 1 = 실제. (과거 6 — 산이 6배로 솟아 실제 원근감과 어긋났다)
export const V_EXAG = 1.0;

// 지구 곡률: 카메라에서 수평거리 d(scene unit = 400m) 인 점의 하강량
//   drop_m = (d·400)² / 2R → scene Y = drop_m / 400 · V_EXAG = d² · 400 · V_EXAG / 2R
const R_EARTH_M = 6371000;
const CURV_K = RENDER_UNIT_M * V_EXAG / (2 * R_EARTH_M);

// 메시 재질에 곡률 하강을 주입. 메시는 회전/스케일 없이 위치만 가진다고 가정(지형 청크·바다 평면).
// 눈높이 2.6m 의 수평선은 ~5.8km — 그 너머 해안 저지대는 실제처럼 수평선 아래로 가라앉는다.
export function applyCurvature(mat: THREE.Material) {
    mat.onBeforeCompile = function (shader) {
        shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', [
            '#include <begin_vertex>',
            'vec4 curvWp = modelMatrix * vec4(transformed, 1.0);',
            'vec2 curvD = curvWp.xz - cameraPosition.xz;',
            'transformed.y -= dot(curvD, curvD) * ' + CURV_K.toExponential(6) + ';',
        ].join('\n'));
    };
    mat.customProgramCacheKey = function () { return 'curv'; };
}

// 씬 원점 (월드 px). 시작 위치로 1회 고정 — 지형 청크는 이 원점 기준 상대 좌표로 생성된다.
export const sceneOrigin = { gx: 0, gy: 0 };
export function setSceneOrigin(gx: number, gy: number) {
    sceneOrigin.gx = gx;
    sceneOrigin.gy = gy;
}

// 미터 → 씬 유닛 (수평 스케일 1 unit = 1 world-px = RENDER_UNIT_M 미터 기준)
export function metersToSceneY(m: number): number {
    return (m / RENDER_UNIT_M) * V_EXAG;
}

// 월드 px → 씬 XZ (원점 기준 상대 좌표)
export function worldToScene(gx: number, gy: number): { x: number; z: number } {
    return { x: gx - sceneOrigin.gx, z: gy - sceneOrigin.gy };
}

// boat.angle(0=북, 증가=반시계) → three Y축 회전.
// moveBoat 전진 벡터 = (-sin(a), -cos(a)) (world dx,dy). world dy → scene z 그대로 매핑되므로
// forward(scene) = (-sin(a), -cos(a)) = (x,z). three 기본 forward(-Z)를 Y축 rotation θ 만큼 돌리면
// (-sinθ, -cosθ) 가 나오므로 θ = a.
export function boatAngleToSceneRotY(angle: number): number {
    return angle;
}

// camera.x/y/angle/heightMeters (state.ts, world 단위) → three PerspectiveCamera 에 적용
export function applyCameraToThree(cam: THREE.PerspectiveCamera) {
    var p = worldToScene(gcam.x, gcam.y);
    cam.position.x = p.x;
    cam.position.z = p.z;
    // gcam.heightMeters = max(BASE_CAM_METERS, 지형고도+여유) — baseline 을 낮은 값으로 치환하되
    // 지형을 타고 넘는 여유분(heightMeters - BASE_CAM_METERS)은 그대로 보존.
    var eyeHeight3D = EYE_HEIGHT_M + Math.max(0, gcam.heightMeters - BASE_CAM_METERS);
    cam.position.y = metersToSceneY(eyeHeight3D);
    cam.rotation.order = 'YXZ';
    cam.rotation.y = boatAngleToSceneRotY(gcam.angle);
    // 수평 시선(rotation.x=0)이면 화면 위 절반이 빈 하늘로 낭비되고 가까운 해안/바다는
    // 화면 아래쪽 좁은 띠에 몰린다 — 살짝 아래로 기울여 근경을 더 보여준다.
    cam.rotation.x = CAM_PITCH;
    cam.rotation.z = 0;
}
