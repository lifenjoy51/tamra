// coast.ts — 셀(400m) 해상도 고도 데이터 위의 연속 해안 필드. 배 충돌과 3D 근경 지형이 같은 함수를 써서
// "보이는 해안선 = 막히는 해안선" 이 되게 한다.
//
// 해안선: 셀 꼭짓점 육지(+1)/바다(-1) 의 bilinear 보간 L 의 0 등고선. 부호 거리 ≈ L / |∇L| (셀 → m).
// 해안 절벽 보정: 400m 데이터는 해식 절벽을 완만한 비탈로 뭉갠다 — 해안선에서 내륙 높이 B 까지
// 짧은 폭(W) 안에 솟게 재성형. B 가 낮으면(모래 해안) W 를 넓혀 완만한 해변으로 남긴다.
// 해안 셀 테두리에서 |d| ≥ 141m(=400/2√2) 이고 W·RISE_W ≤ 140m 라 인접 순수 육지/바다 셀과 이어진다.
import { SEA, MASK, SHIFT, RENDER_UNIT_M } from './config';
import { altitude } from './tiles';
import { heightMeters } from './terrain';

export const SEA_FLOOR_M = -5;    // 바다 꼭짓점 높이 (terrain-mesh 원경과 동일)
const CLIFF_MAX_M = 60;           // 절벽으로 세우는 최대 높이 — 그 위는 RISE_W 에 걸쳐 완만히
const CLIFF_W_M = 20;             // 절벽 폭 (B ≥ 12m)
const BEACH_W_M = 90;             // 해변 폭 (B ≤ 2m)
const RISE_W_M = 140;
const FAR = 1e6;

function altAt(gx: number, gy: number): number {
    return altitude[((gy & MASK) << SHIFT) + (gx & MASK)];
}

// 마지막 sample() 결과
let lV = 0;   // 육지/바다 bilinear 값 L (-1 ~ 1, 셀 경계에서 연속)
let dM = 0;   // 해안선까지 부호 거리 (m, 육지 +) — 셀 경계에서 기울기가 바뀌어 약간 불연속
let baseM = 0; // 육지 꼭짓점만으로 보간한 내륙 높이

function sample(gx: number, gy: number) {
    var x0 = Math.floor(gx), y0 = Math.floor(gy), fx = gx - x0, fy = gy - y0;
    var a00 = altAt(x0, y0), a10 = altAt(x0 + 1, y0), a01 = altAt(x0, y0 + 1), a11 = altAt(x0 + 1, y0 + 1);
    var l00 = a00 > SEA ? 1 : -1, l10 = a10 > SEA ? 1 : -1, l01 = a01 > SEA ? 1 : -1, l11 = a11 > SEA ? 1 : -1;
    var w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy), w01 = (1 - fx) * fy, w11 = fx * fy;
    var ws = 0, hs = 0;
    if (l00 > 0) { ws += w00; hs += w00 * heightMeters[a00]; }
    if (l10 > 0) { ws += w10; hs += w10 * heightMeters[a10]; }
    if (l01 > 0) { ws += w01; hs += w01 * heightMeters[a01]; }
    if (l11 > 0) { ws += w11; hs += w11 * heightMeters[a11]; }
    baseM = ws > 1e-9 ? hs / ws : 0;
    var sum = l00 + l10 + l01 + l11;
    var L = l00 * w00 + l10 * w10 + l01 * w01 + l11 * w11;
    lV = L;
    if (sum === 4 || sum === -4) { dM = sum * FAR; return; }
    var Lx = (l10 - l00) * (1 - fy) + (l11 - l01) * fy;
    var Ly = (l01 - l00) * (1 - fx) + (l11 - l10) * fx;
    dM = L / Math.max(0.1, Math.hypot(Lx, Ly)) * RENDER_UNIT_M;
}

function ss(x: number): number {
    return x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x);
}

// 육지/바다 연속 필드 L (해안선 = 0, 바다 -1, 육지 +1). 해안 근처 기울기 ~2/셀 → L 0.1 ≈ 20m.
// 셀 경계에서 연속이라 충돌 판정에 쓴다 (부호 거리는 경계에서 튀어 배가 걸린다).
export function coastL(gx: number, gy: number): number {
    sample(gx, gy);
    return lV;
}

// 해안선까지 부호 거리(m). 바다 음수, 육지 양수. 해안에서 141m 넘게 떨어지면 ±큰 값.
export function coastDistM(gx: number, gy: number): number {
    sample(gx, gy);
    return dM;
}

// 절벽 보정된 지형 높이(m). 셀 꼭짓점에선 원래 고도(바다는 SEA_FLOOR_M) 그대로.
export function terrainHeightM(gx: number, gy: number): number {
    sample(gx, gy);
    if (dM >= FAR) return baseM;
    if (dM <= -FAR) return SEA_FLOOR_M;
    var w = BEACH_W_M + (CLIFF_W_M - BEACH_W_M) * ss((baseM - 2) / 10);
    if (dM <= 0) return SEA_FLOOR_M * ss(-dM / w);
    var cliff = Math.min(baseM, CLIFF_MAX_M);
    return cliff * ss(dM / w) + (baseM - cliff) * ss(dM / RISE_W_M);
}
