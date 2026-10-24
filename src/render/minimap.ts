// minimap.ts — 좌하단 디버그 미니맵.
// 배 주변 지형 + 타일 경계 + 보트 위치/방향 arrow. -/= 키로 축척 조절.
// 전용 오버레이 캔버스(#mm-overlay)에 그려서 2D(voxel)/3D(lowpoly) 렌더러 어느 쪽이든 위에 겹쳐 보인다.
import { SEA, TILE_SIZE, SHIFT, MASK } from '../config';
import { boat } from '../state';
import { altitude } from '../tiles';

// 월드 픽셀/미니맵 픽셀. -/= 키가 mmState.stride 조작 (입력 핸들러에서 직접 변경).
export const mmState = { stride: 24 };
export const MM_STRIDE_MIN = 0.25;
export const MM_STRIDE_MAX = 2048;

export const MM_SIZE = 108;

// 고도 기반 색상 팔레트. 임계값/색을 한 곳에서 조정.
// SEA: depth(=SEA-alt) 기준 오름차순. LAND: alt-SEA 기준 오름차순. 마지막은 catch-all.
const MM_SEA_THRESH  = [20, 1e9];
const MM_SEA_COLOR   = ['#3c8c20', '#18285a']; // #AABBGGRR(0xFF..) 대신 CSS hex(RRGGBB) 사용
const MM_LAND_THRESH = [20, 60, 120, 1e9];
const MM_LAND_COLOR  = ['#40683a', '#705a3c', '#a07848', '#b0b0b0'];
const MM_BORDER_COLOR = '#c8c8c8';
const MM_GRID_COLOR   = '#808080';
const MM_BOAT_COLOR   = '#ff0000';

// --- 오버레이 캔버스: canvas.ts 의 PX_SCALE 계산을 그대로 재사용해 정수배 pixelated 유지 ---
const overlay = document.createElement('canvas');
overlay.id = 'mm-overlay';
overlay.width = MM_SIZE;
overlay.height = MM_SIZE;
overlay.style.position = 'absolute';
overlay.style.imageRendering = 'pixelated';
overlay.style.pointerEvents = 'none';
overlay.style.display = 'none';
const mctx = overlay.getContext('2d')!;

function fitOverlay() {
    // main.ts/canvas.ts 와 동일한 SCR_W/H 기준 정수배 스케일 계산.
    var SCR_W = 640, SCR_H = 360;
    var s = Math.max(1, Math.min(
        Math.floor(window.innerWidth  / SCR_W),
        Math.floor(window.innerHeight / SCR_H),
    ));
    var MM_X = 6, MM_Y = SCR_H - MM_SIZE - 6;
    overlay.style.left   = (MM_X * s) + 'px';
    overlay.style.top    = (MM_Y * s) + 'px';
    overlay.style.width  = (MM_SIZE * s) + 'px';
    overlay.style.height = (MM_SIZE * s) + 'px';
}
fitOverlay();
window.addEventListener('resize', fitOverlay);

export function initMinimapOverlay() {
    var wrap = document.getElementById('canvas-wrap');
    if (wrap) wrap.appendChild(overlay);
}

export function setMinimapVisible(v: boolean) {
    overlay.style.display = v ? 'block' : 'none';
}

export function DrawMinimap() {
    var STRIDE = mmState.stride;
    var half = MM_SIZE >> 1;
    var imgData = mctx.createImageData(MM_SIZE, MM_SIZE);
    var data = imgData.data;

    for (var my = 0; my < MM_SIZE; my++) {
        var wy = (boat.gy + (my - half) * STRIDE) | 0;
        for (var mx = 0; mx < MM_SIZE; mx++) {
            var wx = (boat.gx + (mx - half) * STRIDE) | 0;
            var off = ((wy & MASK) << SHIFT) + (wx & MASK);
            var alt = altitude[off];
            var thresh, colorHex, key;
            if (alt <= SEA) { thresh = MM_SEA_THRESH;  colorHex = MM_SEA_COLOR;  key = SEA - alt; }
            else            { thresh = MM_LAND_THRESH; colorHex = MM_LAND_COLOR; key = alt - SEA; }
            var hex = colorHex[colorHex.length - 1];
            for (var pi = 0; pi < thresh.length; pi++) {
                if (key < thresh[pi]) { hex = colorHex[pi]; break; }
            }
            var r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
            var di = (my * MM_SIZE + mx) * 4;
            data[di] = r; data[di + 1] = g; data[di + 2] = b; data[di + 3] = 255;
        }
    }
    mctx.putImageData(imgData, 0, 0);

    // 타일 경계 (세로/가로 얇은 선)
    var centerTx = Math.floor(boat.gx / TILE_SIZE);
    var centerTy = Math.floor(boat.gy / TILE_SIZE);
    mctx.fillStyle = MM_GRID_COLOR;
    for (var dt = -2; dt <= 2; dt++) {
        var bdX = (centerTx + dt) * TILE_SIZE - boat.gx;
        var mmx = (half + bdX / STRIDE) | 0;
        if (mmx >= 0 && mmx < MM_SIZE) {
            for (var y = 0; y < MM_SIZE; y += 2) mctx.fillRect(mmx, y, 1, 1);
        }
        var bdY = (centerTy + dt) * TILE_SIZE - boat.gy;
        var mmy = (half + bdY / STRIDE) | 0;
        if (mmy >= 0 && mmy < MM_SIZE) {
            for (var x = 0; x < MM_SIZE; x += 2) mctx.fillRect(x, mmy, 1, 1);
        }
    }

    // 테두리
    mctx.strokeStyle = MM_BORDER_COLOR;
    mctx.lineWidth = 1;
    mctx.strokeRect(0.5, 0.5, MM_SIZE - 1, MM_SIZE - 1);

    // 보트 위치 (중앙) + 방향 화살표
    mctx.fillStyle = MM_BOAT_COLOR;
    mctx.fillRect(half - 1, half - 1, 3, 3);
    var fx = -Math.sin(boat.angle), fy = -Math.cos(boat.angle);
    for (var k = 2; k <= 6; k++) {
        var px = (half + fx * k) | 0;
        var py = (half + fy * k) | 0;
        if (px >= 0 && px < MM_SIZE && py >= 0 && py < MM_SIZE) mctx.fillRect(px, py, 1, 1);
    }
}
