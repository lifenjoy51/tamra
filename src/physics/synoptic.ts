// synoptic.ts — 연속 기상장: 위도·경도·시간의 매끄러운 함수로 바람·구름·안개를 낸다.
// (예전엔 위도대 계단 + 0.2° 격자·주 단위로 툭툭 바뀌는 noise 였다.)
//
//   바람 = 기후값(위도대 대순환 + 동아시아·남아시아 몬순, 계절 보간)
//        + 이동성 고·저기압(기압 편차장의 지균풍, 마찰로 저기압 쪽 20° 꺾임)
//        + 태풍(7~10월, 결정적 진로) + 돌풍(수십 분 규모 흔들림)
//   기압 편차장 = 시간축까지 매끄러운 3D value noise 를 편서풍대는 동쪽, 열대는 서쪽으로 흘린 것.
//     → 저기압이 다가오면 바람이 서서히 돌고(순전·반전) 구름이 짙어진다. 한 곳에서 2~4일 주기.
//   구름 = 기후값 + 저기압(−기압 편차) + 장마 전선(6~7월, 북상) + 태풍 + 국지 뭉게.
//   해무 = 4~7월 황해·동중국해, 따뜻한 남풍이 찬 바다 위로 불 때.
// 모든 함수는 순수 함수(상태 없음) — 너울 계산이 먼 곳·과거의 바람을 그대로 샘플할 수 있다.
//
// 좌표: lat/lon (deg), tH = 게임 시간(시, Unix epoch 기준 — 476년이면 큰 음수). 바람 벡터 (u 동, v 북) = 불어가는 쪽.

const DEG = Math.PI / 180;
const KM_PER_DEG = 111.2;

function ss(x: number): number {
    return x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x);
}
function bump(x: number, c: number, w: number): number {
    var d = (x - c) / w;
    return Math.exp(-d * d);
}
// 부드러운 상자 가중 (가장자리 폭 e 도)
function box(x: number, lo: number, hi: number, e: number): number {
    return ss((x - lo) / e + 0.5) * ss((hi - x) / e + 0.5);
}

// --- 3D value noise (quintic 보간 → 기울기까지 연속) ---
function hash3(ix: number, iy: number, it: number, seed: number): number {
    var h = Math.imul(ix | 0, 374761393) ^ Math.imul(iy | 0, 668265263) ^ Math.imul(it | 0, 1103515245) ^ Math.imul(seed, 2246822519);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    h ^= h >>> 16;
    return (h >>> 0) / 2147483647.5 - 1;   // -1 ~ 1
}
function fade(t: number): number {
    return t * t * t * (t * (t * 6 - 15) + 10);
}
export function noise3(x: number, y: number, t: number, seed: number): number {
    var ix = Math.floor(x), iy = Math.floor(y), it = Math.floor(t);
    var fx = fade(x - ix), fy = fade(y - iy), ft = fade(t - it);
    var a = hash3(ix, iy, it, seed), b = hash3(ix + 1, iy, it, seed);
    var c = hash3(ix, iy + 1, it, seed), d = hash3(ix + 1, iy + 1, it, seed);
    var e = hash3(ix, iy, it + 1, seed), f = hash3(ix + 1, iy, it + 1, seed);
    var g = hash3(ix, iy + 1, it + 1, seed), h = hash3(ix + 1, iy + 1, it + 1, seed);
    var l0 = a + (b - a) * fx, l1 = c + (d - c) * fx, l2 = e + (f - e) * fx, l3 = g + (h - g) * fx;
    var m0 = l0 + (l1 - l0) * fy, m1 = l2 + (l3 - l2) * fy;
    return m0 + (m1 - m0) * ft;
}

// --- 계절 ---
export function dayOfYearAt(tH: number): number {
    var d = tH / 24;
    var y = d / 365.2425;
    return (y - Math.floor(y)) * 365.2425;
}
// 겨울 몬순 세기 (1월 하순 최대, 4~10월 0), 여름 몬순 세기 (7월 중순 최대)
function winterW(day: number): number {
    var c = Math.cos(2 * Math.PI * (day - 22) / 365.2425);
    return c > 0 ? Math.pow(c, 1.2) : 0;
}
function summerW(day: number): number {
    var c = Math.cos(2 * Math.PI * (day - 198) / 365.2425);
    return c > 0 ? Math.pow(c, 1.5) : 0;
}

// --- 기후 바람 (월평균에 가까운 매끄러운 장) ---
const cw = { u: 0, v: 0 };
function climWind(lat: number, lon: number, day: number) {
    var shift = 5 * Math.sin(2 * Math.PI * (day - 81) / 365.2425);
    var eff = lat - shift, a = Math.abs(eff), sg = eff >= 0 ? 1 : -1;
    // 무역풍(동풍·적도향) / 편서풍(서풍·극향) / 극동풍
    var u = -6.5 * bump(a, 14, 9) + 6 * bump(a, 47, 12) - 3 * bump(a, 75, 8);
    var v = sg * (-3.5 * bump(a, 14, 9) + 1.5 * bump(a, 47, 12) - 1 * bump(a, 75, 8));

    // 동아시아 몬순: 겨울 한반도·일본 북서풍(대륙 고기압), 동중국해·대만 북동풍 / 여름 남~남서풍
    var ea = box(lat, 18, 48, 6) * box(lon, 100, 150, 8);
    if (ea > 0) {
        var ww = winterW(day), sw = summerW(day);
        var m = ea * Math.max(ww, sw);
        if (m > 0) {
            var nw = ss((lat - 24) / 8);                       // 남쪽은 북동풍, 북쪽은 북서풍
            var wu = 5.8 * nw - 5 * (1 - nw), wv = -5.8 * nw - 5 * (1 - nw);
            var su = 2, sv = 4.5;
            var s = ww + sw;
            u += (((ww * wu + sw * su) / s) - u) * m;
            v += (((ww * wv + sw * sv) / s) - v) * m;
        }
    }
    // 남·동남아 몬순: 여름 남서풍, 겨울 북동풍
    var sa = box(lat, -10, 28, 6) * box(lon, 55, 125, 8) * (1 - ea);
    if (sa > 0) {
        var ww2 = winterW(day), sw2 = summerW(day);
        var m2 = sa * Math.max(ww2, sw2);
        if (m2 > 0) {
            var s2 = ww2 + sw2;
            u += (((ww2 * -5 + sw2 * 6) / s2) - u) * m2;
            v += (((ww2 * -5 + sw2 * 5) / s2) - v) * m2;
        }
    }
    cw.u = u; cw.v = v;
}

// --- 이동성 고·저기압: 기압 편차 (hPa) ---
// 편서풍대 계는 동쪽으로 ~35 km/h(하루 800 km), 열대 계는 서쪽으로 ~15 km/h. 위도마다 다른 속도로 흘리면
// 시간이 갈수록 장이 찢어지므로 두 장을 따로 흘리고 위도 가중으로 섞는다.
const MID_U_KMH = 35, TROP_U_KMH = -15;
function pressureAnom(lat: number, lon: number, tH: number, day: number): number {
    var y = lat * KM_PER_DEG, x = lon * KM_PER_DEG * 0.82;  // 경도 축척은 중위도(35°) 기준 고정
    var midW = ss((Math.abs(lat) - (20 + 6 * summerW(day))) / 12);
    var p = 0;
    if (midW > 0) {
        var xm = x - MID_U_KMH * tH;
        var amp = 8 + 5 * winterW(day);                       // 겨울 저기압이 더 깊다
        p += midW * amp * (noise3(xm / 1500, y / 1300, tH / 60, 11) + 0.45 * noise3(xm / 650, y / 600, tH / 30, 12));
    }
    if (midW < 1) {
        var xt = x - TROP_U_KMH * tH;
        p += (1 - midW) * 2.5 * noise3(xt / 1200, y / 1000, tH / 72, 13);
    }
    return p;
}

// --- 태풍 (7~10월): 해마다 결정적 후보 진로. 북서진 → 전향 → 북동진 가속 ---
interface Typhoon { t0: number; lat0: number; lon0: number; d1: number; d2: number; vmax: number; }
const tyCache: Record<number, Typhoon[]> = {};
function rnd(a: number, b: number): number {
    return (hash3(a, b, 7, 99) + 1) / 2;
}
function typhoonsOf(year: number): Typhoon[] {
    var c = tyCache[year];
    if (c) return c;
    c = [];
    var yearStartH = Date.UTC(year, 0, 1) / 3.6e6;
    for (var k = 0; k < 16; k++) {
        if (rnd(year, k * 7 + 1) < 0.5) continue;
        c.push({
            t0: yearStartH + (180 + k * 8 + rnd(year, k * 7 + 2) * 8) * 24,
            lat0: 12 + rnd(year, k * 7 + 3) * 8,
            lon0: 128 + rnd(year, k * 7 + 4) * 20,
            d1: (60 + rnd(year, k * 7 + 5) * 80),            // 북서진 시간 (h)
            d2: 36,                                          // 북북서 전향 구간 (h)
            vmax: 28 + rnd(year, k * 7 + 6) * 25,            // 최대 풍속 (m/s)
        });
    }
    tyCache[year] = c;
    return c;
}
const tp = { lat: 0, lon: 0, vmax: 0 };
// 태풍 중심·세기 (시간 t). 수명 밖이면 false.
function typhoonAt(ty: Typhoon, tH: number): boolean {
    var dt = tH - ty.t0;
    if (dt < 0 || dt > 230) return false;
    var segs = [[ty.d1, 292, 18], [ty.d2, 335, 16], [999, 40, 38]];   // [시간, 진행 방위, km/h]
    var x = 0, y = 0, rem = dt;
    for (var i = 0; i < 3 && rem > 0; i++) {
        var h = Math.min(rem, segs[i][0]);
        x += Math.sin(segs[i][1] * DEG) * segs[i][2] * h;
        y += Math.cos(segs[i][1] * DEG) * segs[i][2] * h;
        rem -= h;
    }
    tp.lat = ty.lat0 + y / KM_PER_DEG;
    tp.lon = ty.lon0 + x / (KM_PER_DEG * Math.cos(tp.lat * DEG));
    // 발달 2일 → 고위도·수명 끝에서 쇠약
    var grow = ss(dt / 48), decay = Math.exp(-Math.max(0, tp.lat - 33) / 8) * (1 - ss((dt - 170) / 60));
    tp.vmax = ty.vmax * grow * decay;
    return tp.vmax > 3;
}
const ty = { u: 0, v: 0, cloud: 0, distKm: 1e9 };
// 태풍들의 바람 기여 (반시계 회전 + 25° 유입) · 구름 · 가장 가까운 중심 거리
function typhoonField(lat: number, lon: number, tH: number) {
    ty.u = 0; ty.v = 0; ty.cloud = 0; ty.distKm = 1e9;
    var day = dayOfYearAt(tH);
    if (day < 170 || day > 330 || lat < 0 || lon < 100 || lon > 170) return;
    var year = Math.floor(tH / 24 / 365.2425 + 1970);   // 연말·연초는 태풍철 밖이라 근사로 충분
    var list = typhoonsOf(year);
    for (var i = 0; i < list.length; i++) {
        if (!typhoonAt(list[i], tH)) continue;
        var dx = (lon - tp.lon) * KM_PER_DEG * Math.cos(lat * DEG), dy = (lat - tp.lat) * KM_PER_DEG;
        var r = Math.hypot(dx, dy);
        if (r < ty.distKm) ty.distKm = r;
        if (r > 1800) continue;
        var rm = 45;
        var vt = tp.vmax * (r < rm ? r / rm : Math.pow(rm / r, 0.55)) * Math.exp(-(r / 1000) * (r / 1000));
        var ir = 1 / Math.max(r, 1);
        // 반시계 접선 (−dy, dx) 를 중심 쪽으로 25° 꺾음
        var tx = -dy * ir, tyy = dx * ir, cx = -dx * ir, cy = -dy * ir;
        var c25 = Math.cos(25 * DEG), s25 = Math.sin(25 * DEG);
        ty.u += vt * (tx * c25 + cx * s25);
        ty.v += vt * (tyy * c25 + cy * s25);
        ty.cloud = Math.max(ty.cloud, (tp.vmax / 40) * (r < 350 ? 1 : Math.exp(-(r - 350) / 250)));
    }
}

// --- 공개 API ---
export interface WindSample { u: number; v: number; pressure: number; typhoonKm: number; }

const PD_KM = 60;   // 기압 기울기 중앙차분 간격
export function windAt(lat: number, lon: number, tH: number, out: WindSample): WindSample {
    var day = dayOfYearAt(tH);
    climWind(lat, lon, day);
    var u = cw.u, v = cw.v;
    // 지균풍: V = k × ∇p / (ρ f). 지상 마찰로 0.65배 + 저기압 쪽 20° (북반구 반시계).
    var p = pressureAnom(lat, lon, tH, day);
    var dLat = PD_KM / KM_PER_DEG, dLon = PD_KM / (KM_PER_DEG * Math.max(0.2, Math.cos(lat * DEG)));
    var dpdx = (pressureAnom(lat, lon + dLon, tH, day) - pressureAnom(lat, lon - dLon, tH, day)) * 100 / (2 * PD_KM * 1000);
    var dpdy = (pressureAnom(lat + dLat, lon, tH, day) - pressureAnom(lat - dLat, lon, tH, day)) * 100 / (2 * PD_KM * 1000);
    var sl = Math.sin(Math.max(12, Math.abs(lat)) * DEG) * (lat >= 0 ? 1 : -1);
    var f = 2 * 7.292e-5 * sl;
    var gu = -dpdy / (1.2 * f) * 0.65, gv = dpdx / (1.2 * f) * 0.65;
    var rot = (lat >= 0 ? 20 : -20) * DEG, cr = Math.cos(rot), sr = Math.sin(rot);
    u += gu * cr - gv * sr;
    v += gu * sr + gv * cr;
    typhoonField(lat, lon, tH);
    u += ty.u; v += ty.v;
    // 돌풍: ~20 km·~25분 규모로 세기 ±12%, 방향 ±6°
    var gx = lon * KM_PER_DEG * 0.82 / 20, gy = lat * KM_PER_DEG / 20, gt = tH / 0.4;
    var gs = 1 + 0.12 * noise3(gx, gy, gt, 21), ga = 6 * DEG * noise3(gx, gy, gt, 22);
    var ca = Math.cos(ga), sa = Math.sin(ga);
    out.u = (u * ca - v * sa) * gs;
    out.v = (u * sa + v * ca) * gs;
    out.pressure = p;
    out.typhoonKm = ty.distKm;
    return out;
}

export interface SkySample { cloud: number; precip: number; fog: number; }
const wsTmp: WindSample = { u: 0, v: 0, pressure: 0, typhoonKm: 1e9 };

export function skyAt(lat: number, lon: number, tH: number, out: SkySample): SkySample {
    var day = dayOfYearAt(tH);
    var shift = 5 * Math.sin(2 * Math.PI * (day - 81) / 365.2425);
    var a = Math.abs(lat - shift);
    // 기후: ITCZ 흐림, 아열대 고기압 맑음, 중위도 폭풍대
    var c = 0.32 + 0.35 * bump(a, 3, 8) - 0.14 * bump(a, 25, 7) + 0.12 * bump(a, 55, 12);
    // 저기압 → 흐림, 고기압 → 맑음
    var p = pressureAnom(lat, lon, tH, day);
    c -= p * 0.04;
    // 장마 전선: 5월 중순 오키나와(26°N) → 6월 중순 제주·규슈(32°) → 7월 하순 한반도 중부(38°) 북상 후 소멸
    var baiu = ss((day - 133) / 10) * (1 - ss((day - 208) / 8)) * box(lon, 110, 145, 6);
    if (baiu > 0) {
        var bl = day < 168 ? 26 + 6 * ss((day - 135) / 33) : day < 190 ? 32 + 2 * (day - 168) / 22 : 34 + 4 * ss((day - 190) / 15);
        c += 0.5 * baiu * bump(lat, bl, 2.6);
    }
    typhoonField(lat, lon, tH);
    c += ty.cloud * 0.9;
    // 국지 뭉게: 250 km·10시간 + 80 km·3시간 규모
    var x = lon * KM_PER_DEG * 0.82, y = lat * KM_PER_DEG;
    c += 0.17 * noise3((x - MID_U_KMH * tH * 0.6) / 250, y / 250, tH / 10, 31)
       + 0.09 * noise3(x / 80, y / 80, tH / 3, 32);
    c = c < 0 ? 0 : c > 1 ? 1 : c;
    out.cloud = c;
    out.precip = ss((c - 0.62) / 0.3);
    // 해무: 4~7월(6월 중순 최대) 황해·동중국해·제주 주변, 남풍일 때
    var fogSeason = bump(day, 165, 38) * box(lat, 29, 40, 3) * box(lon, 118, 132, 3);
    var fog = 0;
    if (fogSeason > 0.02) {
        windAt(lat, lon, tH, wsTmp);
        var patch = noise3(x / 150, y / 150, tH / 8, 41);
        fog = fogSeason * ss(wsTmp.v / 4) * ss((patch - 0.05) / 0.35) * (1 - out.precip * 0.5);
    }
    out.fog = fog;
    return out;
}

// 태풍 목록 (디버그)
export function typhoonTrackDebug(year: number, tH: number) {
    return typhoonsOf(year).map(function(t) {
        var on = typhoonAt(t, tH);
        return { startDay: (t.t0 - Date.UTC(year, 0, 1) / 3.6e6) / 24, active: on, lat: on ? tp.lat : null, lon: on ? tp.lon : null, vmax: on ? tp.vmax : null };
    });
}
