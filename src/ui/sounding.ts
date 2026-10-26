// sounding.ts — 납추(測深錘) 측심: 줄에 매단 납을 내려 수심과 바닥 흙을 잰다 (납 밑 홈에 바른 기름에
// 펄·모래·조개껍데기가 묻어 나온다). 5세기 연안 항해의 위치 추정 도구 — 같은 수심이라도 바닥이 펄이면
// 황해·서해 쪽, 검은 모래·현무암 자갈이면 제주 가까이. 수심은 길(사람 키 ≈ 2.4 m) 단위, 줄은 예순 길.
import { boat, ship, tide, sun } from '../state';
import { seaDepthM, terrainHeightM, findNearestLand } from '../coast';
import { showToast } from './toast';
import { uiBlip } from '../audio';

const GIL_M = 2.4;
const LINE_GIL = 60;
let busy = false;

const ONES = ['', '한', '두', '세', '네', '다섯', '여섯', '일곱', '여덟', '아홉'];
const TENS = ['', '열', '스물', '서른', '마흔', '쉰', '예순', '일흔', '여든', '아흔'];
function korCount(n: number): string {
    if (n <= 0) return '반';
    var t = Math.floor(n / 10), o = n % 10;
    if (t === 2 && o === 0) return '스무';
    return (TENS[t] + ONES[o]) || '한';
}

function hash(x: number, y: number): number {
    var h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

// 바닥 흙: 해역·수심·해안 거리 (같은 자리는 늘 같은 결과)
function bottomOf(depth: number): string {
    var lat = sun.lat, lon = sun.lon, r = hash(Math.round(boat.gx / 3), Math.round(boat.gy / 3));
    var nl = findNearestLand(boat.gx, boat.gy, 6);
    var nearM = nl.distM;
    var jeju = lat > 33.0 && lat < 33.7 && lon > 125.9 && lon < 127.1;
    var yellow = lon < 126.8 && lat > 33.8 && lat < 40;
    var westCoast = lon > 125.5 && lon < 127.2 && lat > 34.2 && lat < 38.5;
    if (nearM < 1500) {
        // 해안 바로 앞: 서해는 갯벌, 절벽 해안이면 바위, 낮은 해안이면 모래
        if ((yellow || westCoast) && !jeju) return r < 0.7 ? '발이 빠질 듯한 갯펄' : '펄 섞인 모래';
        var cliff = terrainHeightM(boat.gx + nl.e * nearM / 400 * 1.6, boat.gy + nl.s * nearM / 400 * 1.6) > 15;
        if (jeju) return cliff ? '구멍 숭숭한 검은 돌에 납이 걸린다' : '검은 모래';
        if (cliff) return '바위에 부딪는 소리, 묻어 나온 것이 없다';
        return r < 0.5 ? '굵은 모래' : '모래와 잔자갈';
    }
    if (jeju) return r < 0.5 ? '조개껍데기 섞인 검은 모래' : '잔 현무암 자갈';
    if ((yellow || westCoast) && depth < 90) return r < 0.6 ? '누런 고운 펄' : '모래 섞인 펄';
    if (lon < 124 && lat > 27 && lat < 33 && depth < 80) return '누런 고운 펄';
    if (depth < 60) return r < 0.5 ? '고운 모래' : '조개껍데기 섞인 모래';
    if (depth < 150) return r < 0.5 ? '모래 섞인 회색 펄' : '고운 모래';
    return '푸른빛 도는 고운 펄';
}

export function dropLead() {
    if (busy) return;
    busy = true;
    uiBlip(300);
    var depth = seaDepthM(boat.gx, boat.gy) + tide.heightM;
    if (depth < 0.5) depth = 0.5;
    var gil = Math.round(depth / GIL_M);
    // 줄을 푸는 동안 (깊을수록 오래)
    var waitMs = 900 + Math.min(3200, depth * 25);
    showToast('납추를 내린다…', waitMs + 300);
    setTimeout(function () {
        busy = false;
        uiBlip(gil > LINE_GIL ? 260 : 420);
        var drift = ship.waterMS > 2.5 ? '\n배가 빨라 줄이 비스듬히 끌린다 — 실제보다 깊게 읽혔을 수 있다' : '';
        if (gil > LINE_GIL) {
            showToast(korCount(LINE_GIL) + ' 길 줄이 다 풀려도 바닥에 닿지 않는다' + drift, 6000);
        } else {
            var g = ship.waterMS > 2.5 ? Math.round(gil * 1.15) : gil;
            showToast('물 깊이 ' + korCount(Math.max(1, g)) + ' 길 — ' + bottomOf(depth) + drift, 6500);
        }
    }, waitMs);
}

export function initSoundingUI() {
    var btn = document.getElementById('btn-lead');
    if (btn) btn.addEventListener('click', function () { dropLead(); (btn as HTMLButtonElement).blur(); });
}
