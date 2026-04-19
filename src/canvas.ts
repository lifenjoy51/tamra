import { SCR_W, SCR_H } from './config';

// --- Canvas ---
export const canvas = document.getElementById('c') as HTMLCanvasElement;
export const ctx = canvas.getContext('2d')!;
canvas.width = SCR_W;
canvas.height = SCR_H;

// 뷰포트에 정수배로 맞추는 PX_SCALE (crisp pixel 유지).
// 모듈 로컬로 유지 — 외부에서 읽지 않음.
let PX_SCALE = Math.max(1, Math.min(
    Math.floor(window.innerWidth  / SCR_W),
    Math.floor(window.innerHeight / SCR_H)
));

function fitCanvas() {
    var s = Math.max(1, Math.min(
        Math.floor(window.innerWidth  / SCR_W),
        Math.floor(window.innerHeight / SCR_H)
    ));
    PX_SCALE = s;
    canvas.style.width  = SCR_W * s + 'px';
    canvas.style.height = SCR_H * s + 'px';
}
fitCanvas();
window.addEventListener('resize', fitCanvas);

// --- Double buffer (s-macke/VoxelSpace 패턴) ---
export const imagedata = ctx.createImageData(SCR_W, SCR_H);
const bufarray = new ArrayBuffer(SCR_W * SCR_H * 4);
export const buf8 = new Uint8Array(bufarray);
export const buf32 = new Uint32Array(bufarray);
