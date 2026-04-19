// minimap.ts — 좌하단 디버그 미니맵.
// 배 주변 지형 + 타일 경계 + 보트 위치/방향 arrow. -/= 키로 축척 조절.
import { SCR_W, SCR_H, TILE_SIZE, SEA, SHIFT, MASK } from '../config';
import { buf32 } from '../canvas';
import { boat } from '../state';
import { altitude } from '../tiles';

// 월드 픽셀/미니맵 픽셀. -/= 키가 mmState.stride 조작 (입력 핸들러에서 직접 변경).
export const mmState = { stride: 24 };
export const MM_STRIDE_MIN = 0.25;
export const MM_STRIDE_MAX = 2048;

export function DrawMinimap() {
    var MM_SIZE = 108;
    var MM_X = 6;
    var MM_Y = SCR_H - MM_SIZE - 6;
    var STRIDE = mmState.stride;

    // 테두리
    for (var i = -1; i <= MM_SIZE; i++) {
        if (MM_X + i >= 0 && MM_X + i < SCR_W) {
            if (MM_Y - 1 >= 0) buf32[(MM_Y - 1) * SCR_W + MM_X + i] = 0xFFC8C8C8;
            if (MM_Y + MM_SIZE < SCR_H) buf32[(MM_Y + MM_SIZE) * SCR_W + MM_X + i] = 0xFFC8C8C8;
        }
        if (MM_Y + i >= 0 && MM_Y + i < SCR_H) {
            if (MM_X - 1 >= 0) buf32[(MM_Y + i) * SCR_W + MM_X - 1] = 0xFFC8C8C8;
            if (MM_X + MM_SIZE < SCR_W) buf32[(MM_Y + i) * SCR_W + MM_X + MM_SIZE] = 0xFFC8C8C8;
        }
    }

    // 지형
    var half = MM_SIZE >> 1;
    for (var my = 0; my < MM_SIZE; my++) {
        var wy = (boat.gy + (my - half) * STRIDE) | 0;
        var rowBase = (MM_Y + my) * SCR_W + MM_X;
        for (var mx = 0; mx < MM_SIZE; mx++) {
            var wx = (boat.gx + (mx - half) * STRIDE) | 0;
            var off = ((wy & MASK) << SHIFT) + (wx & MASK);
            var alt = altitude[off];
            var c;
            if (alt <= SEA) {
                var d = SEA - alt;
                c = d > 20 ? 0xFF5A2818 : 0xFF8C3C20;
            } else {
                var a = alt - SEA;
                if      (a < 20)  c = 0xFF3A6840;
                else if (a < 60)  c = 0xFF3C5A70;
                else if (a < 120) c = 0xFF4878A0;
                else              c = 0xFFB0B0B0;
            }
            buf32[rowBase + mx] = c;
        }
    }

    // 타일 경계 (세로/가로 얇은 선)
    var centerTx = Math.floor(boat.gx / TILE_SIZE);
    var centerTy = Math.floor(boat.gy / TILE_SIZE);
    var gridC = 0xFF808080;
    for (var dt = -2; dt <= 2; dt++) {
        var bdX = (centerTx + dt) * TILE_SIZE - boat.gx;
        var mmx = (half + bdX / STRIDE) | 0;
        if (mmx >= 0 && mmx < MM_SIZE) {
            for (var y = 0; y < MM_SIZE; y += 2) buf32[(MM_Y + y) * SCR_W + MM_X + mmx] = gridC;
        }
        var bdY = (centerTy + dt) * TILE_SIZE - boat.gy;
        var mmy = (half + bdY / STRIDE) | 0;
        if (mmy >= 0 && mmy < MM_SIZE) {
            for (var x = 0; x < MM_SIZE; x += 2) buf32[(MM_Y + mmy) * SCR_W + MM_X + x] = gridC;
        }
    }

    // 보트 위치 (중앙) + 방향 화살표
    var cx = MM_X + half, cy = MM_Y + half;
    var RED = 0xFF0000FF;
    for (var dy = -1; dy <= 1; dy++)
        for (var dx = -1; dx <= 1; dx++)
            buf32[(cy + dy) * SCR_W + cx + dx] = RED;
    // 방향: 전진 방향이 -sin, -cos (UpdateCamera와 동일)
    var fx = -Math.sin(boat.angle), fy = -Math.cos(boat.angle);
    for (var k = 2; k <= 6; k++) {
        var px = (cx + fx * k) | 0;
        var py = (cy + fy * k) | 0;
        if (px >= MM_X && px < MM_X + MM_SIZE && py >= MM_Y && py < MM_Y + MM_SIZE)
            buf32[py * SCR_W + px] = RED;
    }
}
