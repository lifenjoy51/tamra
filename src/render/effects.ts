// effects.ts — drawNearFog / drawPrecipitation / drawLightning.
// 모두 buf32 을 직접 덮어쓰는 post-process. Render() 직후 호출 순서:
// drawNearFog(저시정 veil) → drawPrecipitation(비/눈) → drawLightning(뇌전 flash).
import { SCR_W, SCR_H } from '../config';
import { buf32 } from '../canvas';
import { weather, wind, sun, camera, timeRef } from '../state';

// --- Precipitation (비·눈 파티클) ---
// 사전 할당 ~300개. 화면 좌표계에서 직접 이동/그리기 → 저비용.
// precipitation=0이면 drawPrecipitation 즉시 리턴.
var PRECIP_MAX = 300;
var precipX = new Float32Array(PRECIP_MAX);
var precipY = new Float32Array(PRECIP_MAX);
(function initPrecip() {
    for (var i = 0; i < PRECIP_MAX; i++) {
        precipX[i] = Math.random() * SCR_W;
        precipY[i] = Math.random() * SCR_H;
    }
})();

export function drawPrecipitation() {
    var intensity = weather.precipitation;
    if (intensity <= 0.001) return;
    var isSnow = weather.precipType === 'snow';
    var active = (PRECIP_MAX * intensity) | 0;
    // 바람 기반 경사: 풍속·풍향 일부 반영. 화면 상 x축 방향 성분만 쓰면 과함 → 완만히.
    // wind.angleRad: 0=북(바람이 북에서 불어옴). 동쪽 성분 = -sin(angleRad)*speed
    var windX = -Math.sin(wind.angleRad) * wind.speedMS;
    var driftX = windX * 0.18;             // px/frame 근사
    var fallY = isSnow ? 1.2 : 5.5;        // 눈은 느리게, 비는 빠르게
    var rainCol = 0xFFE0C89C;   // light blue-gray (BGR)
    var snowCol = 0xFFF0F0FF;
    for (var i = 0; i < active; i++) {
        var x = precipX[i] + driftX;
        var y = precipY[i] + fallY;
        if (y >= SCR_H || x < 0 || x >= SCR_W) {
            // 재생성: 화면 위쪽 랜덤
            x = Math.random() * SCR_W;
            y = Math.random() * -SCR_H * 0.25;
        }
        precipX[i] = x;
        precipY[i] = y;
        var ix = x | 0, iy = y | 0;
        if (iy < 0 || iy >= SCR_H || ix < 0 || ix >= SCR_W) continue;
        if (isSnow) {
            buf32[iy * SCR_W + ix] = snowCol;
        } else {
            // 비: 짧은 3px 사선 (driftX 방향)
            var dxSign = driftX < 0 ? -1 : 1;
            for (var k = 0; k < 3; k++) {
                var lx = ix - k * dxSign;
                var ly = iy - k;
                if (ly < 0 || ly >= SCR_H || lx < 0 || lx >= SCR_W) break;
                buf32[ly * SCR_W + lx] = rainCol;
            }
        }
    }
}

// --- Near-distance fog (저시정 안개) ---
// visibilityCoef < 0.7 일 때 전체 화면에 옅은 회백색 veil 덧입힘.
// Render()의 거리 fog와 별개로, 근거리까지 감소된 시정을 강화.
export function drawNearFog() {
    var vis = weather.visibilityCoef;
    if (vis >= 0.7) return;
    var strength = (0.7 - vis) * 1.0;
    if (strength > 0.5) strength = 0.5;
    // 안개 색: 주간 = 연회색, 야간 = 짙은 청색
    var fR, fG, fB;
    if (sun.altDeg > 5) { fR = 200; fG = 200; fB = 205; }
    else if (sun.altDeg > -6) { fR = 140; fG = 130; fB = 130; }
    else { fR = 30; fG = 34; fB = 44; }
    var total = SCR_W * SCR_H;
    for (var i = 0; i < total; i++) {
        var bg = buf32[i];
        var bR = bg & 0xFF, bG = (bg >> 8) & 0xFF, bB = (bg >> 16) & 0xFF;
        var nR = (bR + (fR - bR) * strength) | 0;
        var nG = (bG + (fG - bG) * strength) | 0;
        var nB = (bB + (fB - bB) * strength) | 0;
        buf32[i] = 0xFF000000 | (nB << 16) | (nG << 8) | nR;
    }
}

// --- Lightning flash (뇌전) ---
// cloudiness > 0.85 일 때 결정적 gate 로 드문드문 플래시.
// gameTime을 30초 bucket으로 나눠 hash → 확률 체크. flash 길이 ≤ 120ms (real time).
var lightningLastRealMs = -99999;
export function drawLightning() {
    if (weather.cloudiness <= 0.85) return;
    var bucket = (timeRef.gameTime / 30000) | 0;
    var h = ((bucket * 2654435761) >>> 0) / 4294967295;  // 0..1
    // cloudiness 0.85~1.0 → 확률 0.05~0.25
    var prob = (weather.cloudiness - 0.85) * 1.3 + 0.05;
    var shouldFlash = h < prob;
    var nowMs = performance.now();
    if (shouldFlash && nowMs - lightningLastRealMs > 1500) {
        lightningLastRealMs = nowMs;
    }
    var elapsed = nowMs - lightningLastRealMs;
    if (elapsed > 120) return;
    // 플래시 강도: 0~50ms 강, 50~120ms 감쇠
    var strength = elapsed < 50 ? (0.55 - elapsed / 50 * 0.25) : (0.3 * (1 - (elapsed - 50) / 70));
    if (strength <= 0) return;
    var horizonY = (camera && camera.horizon) ? camera.horizon : (SCR_H * 0.5) | 0;
    for (var y = 0; y < SCR_H; y++) {
        var k = y < horizonY ? strength : strength * 0.35;
        var base = y * SCR_W;
        for (var x = 0; x < SCR_W; x++) {
            var bg = buf32[base + x];
            var bR = bg & 0xFF, bG = (bg >> 8) & 0xFF, bB = (bg >> 16) & 0xFF;
            var nR = (bR + (250 - bR) * k) | 0;
            var nG = (bG + (250 - bG) * k) | 0;
            var nB = (bB + (255 - bB) * k) | 0;
            buf32[base + x] = 0xFF000000 | (nB << 16) | (nG << 8) | nR;
        }
    }
}
