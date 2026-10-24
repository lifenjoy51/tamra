// renderer.ts — three.js WebGLRenderer + Scene + Camera (640x360 내부 해상도, pixelated 업스케일).
// WebGLRenderer 는 initRenderer() 에서 지연 생성 — 모듈 로드 시 만들면 WebGL 미지원 환경에서
// import 단계에서 throw 해 2D 모드까지 죽고, 2D 사용자에게도 GL 컨텍스트가 잡힌다.
import * as THREE from 'three';
import { SCR_W, SCR_H } from '../config';

export const canvas3d = document.getElementById('c3d') as HTMLCanvasElement;

export let renderer: THREE.WebGLRenderer | null = null;

export const scene = new THREE.Scene();

// near=1 이면 카메라 높이(약 0.3~1 scene-unit)보다도 커서 발밑 바다가 통째로 클리핑되고
// 그 자리에 스카이돔(수평선색)이 비쳐 보이는 버그가 있었다 — 훨씬 작게 잡는다.
// near/far 비가 8만배라 선형 depth 로는 원거리 해안선(물 평면 ↔ 수중 지형)이 z-fight →
// logarithmicDepthBuffer 로 보정.
export const camera3d = new THREE.PerspectiveCamera(70, SCR_W / SCR_H, 0.05, 4000);

// 성공 시 true. 실패(WebGL 미지원 등)하면 false — 호출 측이 2D 로 폴백.
export function initRenderer(): boolean {
    if (renderer) return true;
    try {
        renderer = new THREE.WebGLRenderer({ canvas: canvas3d, antialias: false, logarithmicDepthBuffer: true });
    } catch (e) {
        console.warn('[render3d] WebGL 초기화 실패 — 2D 렌더러로 폴백', e);
        return false;
    }
    renderer.setPixelRatio(1);
    renderer.setSize(SCR_W, SCR_H, false);
    renderer.shadowMap.enabled = false;
    return true;
}

// 뷰포트에 정수배로 맞추는 CSS 스케일 (canvas.ts 의 PX_SCALE 로직과 동일 — pixelated 유지)
function fitCanvas3d() {
    var s = Math.max(1, Math.min(
        Math.floor(window.innerWidth  / SCR_W),
        Math.floor(window.innerHeight / SCR_H)
    ));
    canvas3d.style.width  = SCR_W * s + 'px';
    canvas3d.style.height = SCR_H * s + 'px';
}
fitCanvas3d();
window.addEventListener('resize', fitCanvas3d);

export function Render3D() {
    renderer!.render(scene, camera3d);
}
