// sea-tint.ts — 바다 물빛: 수심·해역으로 정한다. 옛 뱃사람이 "물빛이 바뀌면 뭍이 가깝다"고 읽던 단서.
//   대양(수심 600m+, 쿠로시오 '흑조') 짙은 남색 → 대륙붕 청록 → 연안(25m-) 초록 →
//   황해·중국 연안·한반도 서해(얕고 탁한 펄물) 누런 녹갈색.
import { seaDepthM } from '../coast';
import { DEG_PER_PIXEL, ORIGIN_LAT, ORIGIN_LON } from '../config';

const DEEP = [0.07, 0.24, 0.42], SHELF = [0.165, 0.56, 0.54], SHALLOW = [0.24, 0.62, 0.48], TURBID = [0.45, 0.52, 0.32];

function ss(x: number): number {
    return x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x);
}
function box(x: number, lo: number, hi: number, e: number): number {
    return ss((x - lo) / e + 0.5) * ss((hi - x) / e + 0.5);
}

export interface Rgb { r: number; g: number; b: number; }

export function seaTint(gx: number, gy: number, out: Rgb): Rgb {
    var depth = seaDepthM(gx, gy);
    var lat = ORIGIN_LAT - gy * DEG_PER_PIXEL, lon = ORIGIN_LON + gx * DEG_PER_PIXEL;
    var r = SHELF[0], g = SHELF[1], b = SHELF[2];
    var deep = ss((depth - 150) / 450);
    r += (DEEP[0] - r) * deep; g += (DEEP[1] - g) * deep; b += (DEEP[2] - b) * deep;
    var shal = 1 - ss((depth - 8) / 22);
    r += (SHALLOW[0] - r) * shal; g += (SHALLOW[1] - g) * shal; b += (SHALLOW[2] - b) * shal;
    // 탁도: 황해·동중국해 안쪽(장강·황하 펄) + 한반도 서해 연안, 얕을수록 짙게
    var yellow = box(lat, 28, 41, 2) * box(lon, 117, 125.5, 1.5) * (1 - ss((depth - 20) / 50));
    var westKr = box(lat, 34.3, 38.5, 0.6) * box(lon, 125.6, 127.2, 0.4) * (1 - ss((depth - 10) / 25));
    var tb = Math.min(0.85, yellow * 0.85 + westKr * 0.45);
    r += (TURBID[0] - r) * tb; g += (TURBID[1] - g) * tb; b += (TURBID[2] - b) * tb;
    out.r = r; out.g = g; out.b = b;
    return out;
}
