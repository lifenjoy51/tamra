// terrain.ts — 고도 LUT + colormap 생성기
// heightmap Uint8 → 실제 미터 역변환 + hillshading RGB.
// generate_maps.py 와 동일 알고리즘. 타일 경계는 edge replication.

import { SEA, TILE_SIZE } from './config';

// --- 구간별 선형 매핑 (piecewise linear) ---
// Uint8 값 → 실제 미터 역변환 LUT (렌더링 시 구간별 scale 보정)
const SEGMENTS = [
    [-8000, -200,   0,  24],
    [ -200,  -10,  24,  48],
    [  -10,    0,  48,  64],
    [    0,   20,  64, 112],
    [   20,  200, 112, 160],
    [  200, 1000, 160, 208],
    [ 1000, 5000, 208, 255],
];

export const heightMeters = new Float32Array(256);
for (var i = 0; i < 256; i++) {
    for (var s = 0; s < SEGMENTS.length; s++) {
        var seg = SEGMENTS[s];
        if (i <= seg[3] || s === SEGMENTS.length - 1) {
            var t = (seg[3] === seg[2]) ? 0 : (i - seg[2]) / (seg[3] - seg[2]);
            t = t < 0 ? 0 : t > 1 ? 1 : t;
            heightMeters[i] = seg[0] + t * (seg[1] - seg[0]);
            break;
        }
    }
}

// --- Colormap 생성 (heightmap → RGB + hillshading) ---
// TODO: 인접 타일 로드되면 경계 1px 재계산하여 이음매 제거
// gtx, gty 는 글로벌 타일 좌표 (디더링 좌표를 타일 경계에서 연속시키기 위함)
export function generateColormap(h, W, H, gtx, gty) {
    W = W || TILE_SIZE;
    H = H || TILE_SIZE;
    gtx = gtx || 0;
    gty = gty || 0;
    var goxX = gtx * TILE_SIZE; // 글로벌 디더링 오프셋
    var goxY = gty * TILE_SIZE;
    var cmap = new Uint32Array(W * H);
    // 광원: 북서 45도
    var LX = Math.cos(Math.PI/4) * Math.sin(Math.PI * 315/180);
    var LY = Math.cos(Math.PI/4) * Math.cos(Math.PI * 315/180);
    var LZ = Math.sin(Math.PI/4);
    var SLOPE = 2.0, SLOPE_SQ = 4.0;

    for (var y = 0; y < H; y++) {
        var yUp = y > 0 ? y - 1 : 0;
        var yDn = y < H - 1 ? y + 1 : H - 1;
        var rowBase = y * W;
        var rowUp = yUp * W, rowDn = yDn * W;
        for (var x = 0; x < W; x++) {
            var xL = x > 0 ? x - 1 : 0;
            var xR = x < W - 1 ? x + 1 : W - 1;
            var idx = rowBase + x;
            var hi = h[idx];

            // Sobel gradient (edge replication)
            var dx = h[rowBase + xR] - h[rowBase + xL];
            var dy = h[rowDn + x]    - h[rowUp + x];

            // Hillshade
            var shade = -dx * SLOPE * LX - dy * SLOPE * LY + LZ;
            shade /= Math.sqrt(dx * dx * SLOPE_SQ + dy * dy * SLOPE_SQ + 1.0);
            if (shade < 0) shade = 0;
            else if (shade > 1) shade = 1;

            // 디더링 노이즈 (글로벌 좌표 기준 → 타일 경계 연속)
            var gX = goxX + x, gY = goxY + y;
            var n = (((gX * 7 + gY * 13) ^ (gX + gY * 3)) & 15) - 7;

            var r, g, b;
            if (hi <= SEA) {
                // 바다 — sqrt 커브로 shore 주변 연청록 대비 강조, 그 후 선형으로 심해 navy
                var xd = (SEA - hi) * (1/SEA);
                if (xd < 0) xd = 0; else if (xd > 1) xd = 1;
                var tt = Math.sqrt(xd); // shore 근처 급변
                r = 150 - tt * 132;  // 150 → 18
                g = 200 - tt * 158;  // 200 → 42
                b = 200 - tt * 100;  // 200 → 100
                r += n * 0.3; g += n * 0.3; b += n * 0.3;
                // 바다는 hillshading 적용 안함
            } else {
                // 육지 (고도별)
                var a = hi - SEA;
                var t;
                if (a < 6) {
                    r = 194; g = 178; b = 130;
                } else if (a < 48) {
                    t = (a - 6) / 42;
                    r = 50 + t * 25;  g = 100 + t * 30;  b = 30 + t * 10;
                } else if (a < 96) {
                    t = (a - 48) / 48;
                    r = 75 + t * 35;  g = 130 - t * 15;  b = 40 + t * 15;
                } else if (a < 130) {
                    t = (a - 96) / 34;
                    r = 110 + t * 30; g = 105 - t * 15;  b = 55 + t * 10;
                } else if (a < 155) {
                    t = (a - 130) / 25;
                    r = 140 - t * 15; g = 90 - t * 10;   b = 65 + t * 15;
                } else {
                    t = (a - 155) / 36;
                    if (t > 1) t = 1;
                    r = 125 + t * 30; g = 80 + t * 30;   b = 80 + t * 30;
                }
                r += n * 0.5; g += n * 0.5; b += n * 0.4;
                // hillshading
                var light = 0.35 + 0.65 * shade;
                r *= light; g *= light; b *= light;
            }

            r = r < 0 ? 0 : r > 255 ? 255 : r | 0;
            g = g < 0 ? 0 : g > 255 ? 255 : g | 0;
            b = b < 0 ? 0 : b > 255 ? 255 : b | 0;
            cmap[idx] = 0xFF000000 | (b << 16) | (g << 8) | r;
        }
    }
    return cmap;
}
