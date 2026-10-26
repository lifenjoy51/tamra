// waves.ts — swell(너울) ← 먼 바다·과거의 바람, mid/ripple ← 지금 이 자리의 바람.
//
// 너울은 국지풍과 별개로 수백~2천 km 밖의 바람이 만든 물결이 군속도(~35 km/h)로 건너온 것이다.
// 16방위 × 4거리의 "그때 그곳" 바람(synoptic.windAt 을 거리/군속도 만큼 과거로)을 샘플해
// 배 쪽으로 부는 성분의 에너지를 모으고, 사이에 섬·육지가 있으면 가린다(로드된 타일 범위 안).
// → 구름이 하늘을 덮어도 같은 방향에서 오는 너울로 침로를 잡을 수 있고, 태풍 너울이 폭풍보다 먼저 온다.
import { wave, wind, sun, boat, timeRef } from '../state';
import { windAt, WindSample } from './synoptic';
import { isLandPx } from '../coast';
import { DEG_PER_PIXEL } from '../config';

const K_SWELL = 0.128, K_MID = 0.31, K_RIPPLE = 0.75;
const DIRS = 16, DISTS_KM = [300, 700, 1200, 1800];
const CG_KMH = 35;              // 너울 군속도
const SHADOW_PX = 1000;         // 육지 차폐 검사 반경 (5×5 타일 로드 범위 안)
const RECALC_H = 1 / 6;         // 10분 게임시간마다 재계산
const TAU_H = 3;                // 너울 변화 시상수

const ws: WindSample = { u: 0, v: 0, pressure: 0, typhoonKm: 1e9 };
let lastH = NaN;
let sE = 0, sN = 0;             // 평활된 너울 벡터 (Hs × 진행 방향, 동/북)

function sheltered(dirE: number, dirN: number, distKm: number): boolean {
    var kmPerPxY = DEG_PER_PIXEL * 111.2, kmPerPxX = kmPerPxY * Math.cos(sun.lat * Math.PI / 180);
    var maxPx = Math.min(SHADOW_PX, distKm / kmPerPxY);
    for (var s = 3; s < maxPx; s += 6) {
        // 배 → 너울 출처 방향으로 진행
        if (isLandPx(boat.gx + dirE * s * kmPerPxY / kmPerPxX, boat.gy - dirN * s)) return true;
    }
    return false;
}

function updateSwell(tH: number) {
    var dt = isNaN(lastH) ? 1e9 : tH - lastH;
    if (dt >= 0 && dt < RECALC_H) return;
    var first = isNaN(lastH) || dt < 0 || dt > 48;
    lastH = tH;
    var lat = sun.lat, lon = sun.lon, cosLat = Math.cos(lat * Math.PI / 180);
    var eSum = 0, vE = 0, vN = 0;
    for (var d = 0; d < DIRS; d++) {
        var th = d * 2 * Math.PI / DIRS;             // 출처 방위
        var ue = Math.sin(th), un = Math.cos(th);
        var shade = sheltered(ue, un, DISTS_KM[DISTS_KM.length - 1]) ? 0.12 : 1;
        for (var k = 0; k < DISTS_KM.length; k++) {
            var D = DISTS_KM[k];
            windAt(lat + un * D / 111.2, lon + ue * D / (111.2 * cosLat), tH - D / CG_KMH, ws);
            // 출처에서 배 쪽(−ue, −un)으로 부는 성분
            var U = Math.hypot(ws.u, ws.v);
            var along = -(ws.u * ue + ws.v * un);
            if (along <= 0 || U < 0.5) continue;
            var hs = 0.024 * U * U * (along / U) * (along / U);
            var e = hs * hs / (1 + D / 600) * shade;
            eSum += e;
            var w = e * Math.sqrt(e);
            vE -= ue * w; vN -= un * w;               // 진행 방향 = 출처 반대
        }
    }
    var hsT = Math.min(8, Math.sqrt(0.27 * eSum));
    if (hsT < 0.15) hsT = 0.15;
    var vl = Math.hypot(vE, vN);
    var tE: number, tN: number;
    if (vl > 1e-9) { tE = vE / vl * hsT; tN = vN / vl * hsT; }
    else { var l0 = Math.hypot(sE, sN) || 1; tE = sE / l0 * hsT; tN = sN / l0 * hsT; }
    var a = first ? 1 : 1 - Math.exp(-dt / TAU_H);
    sE += (tE - sE) * a; sN += (tN - sN) * a;
}

export function computeWaves() {
    updateSwell(timeRef.gameTime / 3.6e6);
    var hs = Math.hypot(sE, sN) || 0.15;
    var pe = sE / hs, pn = sN / hs;                   // 너울 진행 방향 (동, 북)
    wave.swellHs = hs;
    wave.swellFromRad = Math.atan2(-pe, -pn);
    if (wave.swellFromRad < 0) wave.swellFromRad += 2 * Math.PI;
    var windFlow = wind.angleRad + Math.PI;  // 바람이 "부는" 방향
    wave.swell.dx  =  pe * K_SWELL;
    wave.swell.dy  = -pn * K_SWELL;               // 월드 y 는 남쪽
    wave.mid.dx    =  Math.sin(windFlow) * K_MID;
    wave.mid.dy    = -Math.cos(windFlow) * K_MID;
    wave.ripple.dx =  Math.sin(windFlow) * K_RIPPLE;
    wave.ripple.dy = -Math.cos(windFlow) * K_RIPPLE;
    var ampF = wind.speedMS / 8;
    if (ampF < 0.2) ampF = 0.2; else if (ampF > 2.0) ampF = 2.0;
    var sa = 0.8 + 1.4 * hs;
    wave.swell.amp  = sa < 1 ? 1 : sa > 7 ? 7 : sa;
    wave.mid.amp    = 1.2 * ampF;
    wave.ripple.amp = 0.4 * ampF;
}
