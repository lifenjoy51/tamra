// current.ts — 해류(대양 순환 + 경로선 해류) + 조류(달·해의 M2·S2 조석).
// flow direction: 0 = 북쪽으로 흐름, π/2 = 동쪽으로 흐름. current.* 는 해류+조류 합.
//
// 해류: 예전엔 쿠로시오를 동경 110~150°·북위 20~45° 상자 전체(황해·대한해협·제주 포함)에 북동 1.2 m/s 로
//   깔았다. 이제 실제 축을 따라 그린 경로선(쿠로시오·쓰시마 난류·동한 난류·제주 난류·황해 난류·중국 연안류 등)
//   에서 떨어질수록 가우시안으로 약해진다. 겨울·여름에 세기가 바뀌는 해류는 계절 가중.
// 조류: 조석파의 진폭·위상(공조시도)을 몇 개 기준점에서 복소수 역거리 보간 → 그 자리 만조 시각과 조차.
//   조류는 정상파 근사: 밀물(창조) 최강은 물이 차오르는 중간, 만조·간조 때 정조(물 멈춤).
//   세기 ≈ 조석 진폭 × √(g/수심) — 얕은 연안·서해에서 1~3 m/s, 대양에선 거의 0.
//   M2(달, 12.42h) + S2(해, 12h) 의 맥놀이로 보름·그믐 1~2일 뒤 사리, 상·하현 무렵 조금.
//   흐름 방향은 조석파가 나아가는 쪽(위상이 늦어지는 쪽)이 밀물, 해안 셀 안에선 해안선을 따라 꺾는다.
import { current, tide, sun, boat, moonState, timeRef } from '../state';
import { seaDepthM, coastNormalAt, isLandPx } from '../coast';
import { DEG_PER_PIXEL } from '../config';
import { dayOfYearAt } from './synoptic';

const DEG = Math.PI / 180;
const KM = 111.2;

function bump(x: number, c: number, w: number): number {
    var d = (x - c) / w;
    return Math.exp(-d * d);
}

// --- 경로선 해류 [경도, 위도] 점열 · 최대 유속(m/s) · 반폭(km) · 계절(0 상시, 1 겨울 강화, 2 여름 강화) ---
interface Stream { pts: number[][]; spd: number; w: number; season: number; box: number[]; }
function mk(pts: number[][], spd: number, w: number, season: number): Stream {
    var lo0 = 1e9, lo1 = -1e9, la0 = 1e9, la1 = -1e9;
    for (var i = 0; i < pts.length; i++) {
        lo0 = Math.min(lo0, pts[i][0]); lo1 = Math.max(lo1, pts[i][0]);
        la0 = Math.min(la0, pts[i][1]); la1 = Math.max(la1, pts[i][1]);
    }
    var m = w * 3 / KM;
    return { pts, spd, w, season, box: [lo0 - m * 1.5, lo1 + m * 1.5, la0 - m, la1 + m] };
}
const STREAMS: Stream[] = [
    // 쿠로시오: 대만 동쪽 → 동중국해 대륙붕단 → 토카라 해협 → 일본 남안 → 동쪽으로 이탈
    mk([[121.0, 21.5], [121.8, 23.5], [122.6, 25.0], [124.0, 26.0], [126.5, 27.5], [128.5, 29.0], [129.8, 30.0],
        [131.0, 30.9], [132.5, 32.2], [134.5, 33.0], [136.5, 33.6], [138.5, 34.2], [140.3, 35.2], [142.5, 36.0],
        [146.0, 36.5], [152.0, 37.0]], 1.3, 55, 0),
    // 쓰시마 난류: 규슈 서쪽에서 갈라져 대한해협 → 동해
    mk([[126.5, 30.5], [127.6, 32.0], [128.8, 33.8], [129.6, 34.6], [130.6, 35.6], [132.5, 37.0], [135.0, 38.5],
        [138.0, 40.0], [140.0, 41.5]], 0.45, 50, 0),
    // 동한 난류: 한반도 동해안 북상
    mk([[129.4, 35.2], [129.6, 36.5], [129.8, 38.0], [130.5, 39.2]], 0.4, 30, 0),
    // 제주 난류: 제주 서쪽에서 시계방향으로 돌아 제주해협을 동쪽으로
    mk([[125.4, 32.8], [125.9, 33.7], [126.6, 34.0], [127.4, 34.05], [128.3, 34.4]], 0.25, 22, 0),
    // 황해 난류 (겨울 강화): 황해 중앙 북상
    mk([[125.4, 32.2], [124.5, 34.0], [124.0, 36.0], [123.5, 37.6]], 0.12, 70, 1),
    // 중국 연안류 (겨울 강화): 산둥 → 장강 하구 → 저장 남하
    mk([[122.6, 37.0], [121.0, 35.2], [121.4, 33.0], [122.2, 31.0], [121.6, 28.5], [120.2, 26.0]], 0.22, 45, 1),
    // 대만 난류 (여름 강화): 대만해협 북상
    mk([[118.2, 23.2], [120.0, 25.5], [121.5, 27.5], [123.0, 29.5]], 0.3, 50, 2),
    // 리만 한류: 동해 서쪽 남하
    mk([[140.0, 47.0], [137.0, 43.5], [133.5, 42.6], [131.2, 41.8], [130.2, 40.2]], 0.15, 40, 0),
    // 오야시오: 홋카이도 동쪽 남하
    mk([[147.0, 44.0], [145.2, 41.8], [143.0, 39.5]], 0.3, 60, 0),
    // 동호주 해류
    mk([[153.6, -23.0], [154.0, -28.0], [153.5, -32.0], [152.0, -36.0]], 1.0, 60, 0),
];

const flow = { e: 0, n: 0 };
function streamFlow(lat: number, lon: number, day: number) {
    flow.e = 0; flow.n = 0;
    var winter = Math.max(0, Math.cos(2 * Math.PI * (day - 22) / 365.2425));
    var summer = Math.max(0, Math.cos(2 * Math.PI * (day - 198) / 365.2425));
    var cl = Math.cos(lat * DEG);
    for (var s = 0; s < STREAMS.length; s++) {
        var st = STREAMS[s], b = st.box;
        if (lon < b[0] || lon > b[1] || lat < b[2] || lat > b[3]) continue;
        var best = 1e18, te = 0, tn = 0;
        for (var i = 0; i + 1 < st.pts.length; i++) {
            var p0 = st.pts[i], p1 = st.pts[i + 1];
            var ax = (p1[0] - p0[0]) * KM * cl, ay = (p1[1] - p0[1]) * KM;
            var px = (lon - p0[0]) * KM * cl, py = (lat - p0[1]) * KM;
            var L2 = ax * ax + ay * ay;
            var t = L2 > 0 ? (px * ax + py * ay) / L2 : 0;
            t = t < 0 ? 0 : t > 1 ? 1 : t;
            var dx = px - ax * t, dy = py - ay * t, d2 = dx * dx + dy * dy;
            if (d2 < best) { best = d2; var L = Math.sqrt(L2) || 1; te = ax / L; tn = ay / L; }
        }
        var k = st.season === 1 ? 0.45 + 0.55 * winter : st.season === 2 ? 0.25 + 0.75 * summer : 1;
        var v = st.spd * k * Math.exp(-best / (st.w * st.w));
        flow.e += te * v; flow.n += tn * v;
    }
}

// --- 대양 순환 배경 (매끄러운 위도 함수): 적도 서향류, 편서풍 취송류 ---
function gyreFlow(lat: number) {
    var a = Math.abs(lat);
    flow.e += -0.3 * bump(a, 10, 9) + 0.12 * bump(a, 45, 10) - 0.08 * bump(a, 62, 6);
}

// --- 조석: 기준점 [경도, 위도, M2 진폭 m, M2 위상 °] — 공조시도 근사 (서해는 북쪽으로 갈수록 만조가 늦고 조차가 크다) ---
const TIDE_PTS = [
    [125.0, 30.0, 0.90, 180], [126.5, 33.1, 0.75, 205], [126.6, 34.0, 1.00, 220], [126.3, 34.8, 1.45, 250],
    [126.5, 36.0, 2.15, 300], [126.6, 37.45, 2.90, 340], [124.3, 35.0, 0.35, 280], [124.8, 37.5, 1.30, 330],
    [121.0, 36.5, 0.90, 60], [120.5, 34.5, 1.20, 100], [122.0, 31.0, 1.20, 130], [121.5, 28.5, 1.50, 160],
    [129.0, 35.1, 0.45, 240], [129.3, 34.4, 0.70, 230], [129.8, 32.7, 0.85, 200], [131.5, 38.0, 0.05, 0],
    [128.0, 26.0, 0.60, 180], [135.0, 33.0, 0.50, 180], [119.5, 39.0, 0.80, 20],
];
const S2_RATIO = 0.4, S2_LAG = 28;    // S2 진폭비·위상 지연 (사리가 보름 1~2일 뒤)
const tz = { re: 0, im: 0 };
function tideM2(lat: number, lon: number) {
    var re = 0, im = 0, ws = 0, cl = Math.cos(lat * DEG);
    for (var i = 0; i < TIDE_PTS.length; i++) {
        var p = TIDE_PTS[i];
        var dx = (lon - p[0]) * cl, dy = lat - p[1];
        // 가우시안 커널(폭 1.3°) — 역거리 가중은 기준점마다 평평한 웅덩이가 생겨 밀물 방향(위상 기울기)이 튄다
        var w = Math.exp(-(dx * dx + dy * dy) / 1.7);
        re += w * p[2] * Math.cos(p[3] * DEG); im += w * p[2] * Math.sin(p[3] * DEG);
        ws += w;
    }
    // 기준점에서 멀어진 대양은 진폭 0.5m 쪽으로
    var far = Math.min(1, ws / 0.5);
    tz.re = re / ws * far + 0.5 * (1 - far);
    tz.im = im / ws * far;
}

// --- 막힌 축: 16방위로 CH_R_KM 까지 첫 육지를 찾아 방향 텐서 M = Σ w·n·nᵀ 를 만들고 주축(가장 막힌 방향)에
// 수직인 축을 열린 축으로. 한쪽 해안이면 해안선 방향, 양쪽(해협)이면 해협 방향. 배가 1px 넘게 움직일 때만 다시 계산.
const CH_R_KM = 60, CH_DIRS = 16;
const chan = { te: 1, tn: 0, s: 0 };
let chanGx = NaN, chanGy = NaN;
function updateChannel(lat: number) {
    if (Math.abs(boat.gx - chanGx) < 1 && Math.abs(boat.gy - chanGy) < 1) return;
    chanGx = boat.gx; chanGy = boat.gy;
    var kmY = DEG_PER_PIXEL * KM, kmX = kmY * Math.cos(lat * DEG);
    var mxx = 0, mxy = 0, myy = 0;
    for (var k = 0; k < CH_DIRS; k++) {
        var th = k * 2 * Math.PI / CH_DIRS, de = Math.sin(th), dn = Math.cos(th);
        for (var d = 1; d <= CH_R_KM; d += 2) {
            if (isLandPx(boat.gx + de * d / kmX, boat.gy - dn * d / kmY)) {
                var w = 1 - d / CH_R_KM;
                mxx += w * de * de; mxy += w * de * dn; myy += w * dn * dn;
                break;
            }
        }
    }
    // 2×2 대칭 행렬 고유값: 큰 쪽 λ1 = 막힌 축
    var tr = mxx + myy, df = Math.sqrt((mxx - myy) * (mxx - myy) / 4 + mxy * mxy);
    var l1 = tr / 2 + df, l2 = tr / 2 - df;
    var be: number, bn: number;
    if (Math.abs(mxy) > 1e-9) { be = l1 - myy; bn = mxy; } else if (mxx >= myy) { be = 1; bn = 0; } else { be = 0; bn = 1; }
    var bl = Math.hypot(be, bn) || 1;
    be /= bl; bn /= bl;
    // 열린 축 = 막힌 축의 수직 (동쪽 성분 ≥ 0 으로 방향 고정 → 밀물/썰물 부호가 일정)
    var te = bn, tn = -be;
    if (te < 0 || (te === 0 && tn < 0)) { te = -te; tn = -tn; }
    chan.te = te; chan.tn = tn;
    // 강도: 막힘의 비등방성 × 막힘 정도
    var aniso = (l1 - l2) / (l1 + 1e-9);
    chan.s = Math.min(1, l1 / 1.5) * Math.min(1, aniso * 1.2);
}

function tideFlow(lat: number, lon: number, tH: number) {
    tideM2(lat, lon);
    var A = Math.hypot(tz.re, tz.im), g = Math.atan2(tz.im, tz.re);
    // 밀물 방향 = 위상이 늦어지는 쪽 (∇g)
    var e = 0.15;
    tideM2(lat, lon + e); var gE = Math.atan2(tz.im, tz.re);
    tideM2(lat + e, lon); var gN = Math.atan2(tz.im, tz.re);
    var dgE = ((gE - g + 3 * Math.PI) % (2 * Math.PI)) - Math.PI, dgN = ((gN - g + 3 * Math.PI) % (2 * Math.PI)) - Math.PI;
    var fe = dgE / Math.cos(lat * DEG), fn = dgN, fl = Math.hypot(fe, fn);
    if (fl < 1e-9) { fe = 0; fn = 1; } else { fe /= fl; fn /= fl; }

    var vM2 = 2 * moonState.ghaRad;
    var utH = ((tH % 24) + 24) % 24;
    var vS2 = 2 * (utH - 12) * 15 * DEG;
    var aS2 = A * S2_RATIO, gS2 = g + S2_LAG * DEG;
    tide.heightM = A * Math.cos(vM2 - g) + aS2 * Math.cos(vS2 - gS2);
    // 수위 상승률에 비례 (정상파: 만조·간조에 정조)
    var q = -(A * Math.sin(vM2 - g) + aS2 * Math.sin(vS2 - gS2));
    // 조차 (그날의 사리·조금): M2·S2 위상차
    tide.rangeM = 2 * Math.hypot(A + aS2 * Math.cos((vS2 - gS2) - (vM2 - g)), aS2 * Math.sin((vS2 - gS2) - (vM2 - g)));
    tide.springRangeM = 2 * (A + aS2);

    var depth = seaDepthM(boat.gx, boat.gy);
    if (depth < 4) depth = 4;
    var spd = q * Math.sqrt(9.8 / depth) * 1.5;
    if (spd > 3) spd = 3; else if (spd < -3) spd = -3;
    var ue = fe * spd, un = fn * spd;
    // 해협·해안: 주변 육지가 막는 축을 빼고 열린 축(해협·해안선 방향)으로 돌린다 — 세기는 유지
    updateChannel(lat);
    if (chan.s > 0.01) {
        var al = ue * chan.te + un * chan.tn, mag = Math.hypot(ue, un), sg = al >= 0 ? 1 : -1;
        ue += (sg * mag * chan.te - ue) * chan.s;
        un += (sg * mag * chan.tn - un) * chan.s;
    }
    // 해안 셀: 육지로 향하는 성분을 빼서 해안선을 따라 흐르게 (월드 y 는 남쪽 → 북 성분 부호 반전)
    var nrm = coastNormalAt(boat.gx, boat.gy);
    if (nrm.distM < 1e8) {
        var ne = nrm.x, nn = -nrm.y;
        var into = ue * ne + un * nn;
        ue -= ne * into; un -= nn * into;
    }
    flow.e += ue; flow.n += un;
    tide.flowMS = Math.hypot(ue, un);
    tide.flowDirRad = Math.atan2(ue, un);
    if (tide.flowDirRad < 0) tide.flowDirRad += 2 * Math.PI;
    tide.depthM = depth;
}

export function computeCurrent() {
    var lat = sun.lat, lon = sun.lon, tH = timeRef.gameTime / 3.6e6;
    streamFlow(lat, lon, dayOfYearAt(tH));
    gyreFlow(lat);
    current.streamMS = Math.hypot(flow.e, flow.n);
    tideFlow(lat, lon, tH);
    var dir = Math.atan2(flow.e, flow.n);
    if (dir < 0) dir += 2 * Math.PI;
    current.angleRad = dir;
    current.speedMS = Math.hypot(flow.e, flow.n);
}
