// coords.ts — 월드(px/미터/라디안) ↔ three.js 씬 좌표 변환 (lowpoly PoC 전용).
// 씬 XZ평면 = 월드 픽셀 그대로 (origin 만 보트 시작 위치로 이동해 float 정밀도 확보).
// Y(높이) = heightMeters(m) / RENDER_UNIT_M(400) * V_EXAG — 수평 스케일과 맞춘 뒤 과장.
import * as THREE from 'three';
import { RENDER_UNIT_M } from '../config';
import { camera as gcam, boat, BASE_CAM_METERS } from '../state';

// 2D voxel 렌더러는 곡률 계산 때문에 눈높이를 50m(BASE_CAM_METERS)로 고정해 쓰는데,
// 3D 에서 그대로 쓰면 시야가 너무 높아져 해안이 실제보다 훨씬 멀어 보인다.
// 같은 "지형 위 여유고도" 관계는 유지한 채 기준 눈높이만 훨씬 낮춘다(작은 배 위 시점).
const EYE_HEIGHT_3D_BASE = 3.5; // m — 바다 위 기준 눈높이

// 수직 과장 배수 — 실제 미터를 그대로 쓰면 산이 지나치게 납작해 보여 튜닝.
// 특히 해안 저지대(수~수십m 기복)는 낮은 시점에서 거의 안 보여 "해안이 멀어 보이는" 원인이 됨.
export const V_EXAG = 6.0;

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
    var eyeHeight3D = EYE_HEIGHT_3D_BASE + Math.max(0, gcam.heightMeters - BASE_CAM_METERS);
    cam.position.y = metersToSceneY(eyeHeight3D);
    cam.rotation.order = 'YXZ';
    cam.rotation.y = boatAngleToSceneRotY(gcam.angle);
    // 수평 시선(rotation.x=0)이면 화면 위 절반이 빈 하늘로 낭비되고 가까운 해안/바다는
    // 화면 아래쪽 좁은 띠에 몰린다 — 살짝 아래로 기울여 근경을 더 보여준다.
    cam.rotation.x = -0.05;
    cam.rotation.z = 0;
}
