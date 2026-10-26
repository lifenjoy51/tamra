// stars.ts — 항성 테이블 + alt/az 갱신.
// STARS: 5.5등급까지 ~2850개 (star-catalog.ts, Hipparcos 기반 J2000).
// updateStars: 고유운동 + 세차(J2000 → 그 해의 평균 춘분점) → GMST → LST → 시간각 → alt/az,
// 이후 updatePlanets/updateMoon 호출. 476년 무렵엔 세차로 하늘이 ~21° 돌아가 있다 — Polaris 는
// 극에서 9° 떨어져 원을 그리고, 극 근처엔 5등성 紐星(32 H Cam, 1.9°)뿐.
import { sun, timeRef, moonState, weather } from '../state';
import { updatePlanets } from './planets';
import { updateMoon } from './moon';
import { STAR_ROWS, STAR_NAMES } from './star-catalog';

export const STARS = STAR_ROWS.map(function(r, i) {
    return { ra: r[0], dec: r[1], mag: r[2], bv: r[3], pmRa: r[4], pmDec: r[5], n: STAR_NAMES[i] || '' };
});

export const starState = STARS.map(function() { return { altRad: 0, azRad: 0 }; });

// 별 twinkle 위상·주파수 (결정적, 한 번만 초기화)
export const starTwinklePhase = new Float32Array(STARS.length);
export const starTwinkleFreq  = new Float32Array(STARS.length);
(function initTwinkle() {
    for (var i = 0; i < STARS.length; i++) {
        var h = (STARS[i].ra * 73.0 + STARS[i].dec * 31.0);
        starTwinklePhase[i] = (h % (Math.PI * 2));
        starTwinkleFreq[i]  = 1.5 + ((h * 17) % 10) / 10 * 2.5;
    }
})();

// 세차·고유운동 적용한 그 해의 적경(h)/적위(rad). 세차는 연 50" 라 게임 연도 바뀔 때만 다시 계산.
const raDate = new Float64Array(STARS.length);
const decDate = new Float64Array(STARS.length);
let epochYear = NaN;

// J2000 → 율리우스 세기 T 의 평균 춘분점 (IAU 1976 엄밀식, ±수천 년 유효)
function precessCatalog(T: number) {
    var DEG = Math.PI / 180, AS = DEG / 3600;
    var zeta = (2306.2181 * T + 0.30188 * T * T + 0.017998 * T * T * T) * AS;
    var z = (2306.2181 * T + 1.09468 * T * T + 0.018203 * T * T * T) * AS;
    var th = (2004.3109 * T - 0.42665 * T * T - 0.041833 * T * T * T) * AS;
    var cT = Math.cos(th), sT = Math.sin(th);
    var yrs = T * 100;
    for (var i = 0; i < STARS.length; i++) {
        var s = STARS[i];
        var dec0 = s.dec * DEG;
        // 고유운동 (mas/yr) — 아크투루스·시리우스·센타우루스α 는 1500년에 0.5~1.6° 움직인다
        var d = dec0 + s.pmDec * yrs * AS / 1000;
        var a = s.ra * 15 * DEG + s.pmRa * yrs * AS / 1000 / Math.max(0.01, Math.cos(dec0));
        var cD = Math.cos(d), sD = Math.sin(d);
        var A = cD * Math.sin(a + zeta);
        var B = cT * cD * Math.cos(a + zeta) - sT * sD;
        var C = sT * cD * Math.cos(a + zeta) + cT * sD;
        var ra = Math.atan2(A, B) + z;
        if (ra < 0) ra += 2 * Math.PI;
        raDate[i] = ra * 12 / Math.PI;
        decDate[i] = Math.asin(C > 1 ? 1 : C < -1 ? -1 : C);
    }
}

// ΔT (TT − UT, 초): 지구 자전 감속. 476년 ≈ 1.6시간 — 달·행성 위치(TT 기준)에 반영.
export function deltaTSec(year: number): number {
    var u = (year - 1820) / 100;
    return -20 + 32 * u * u;
}

export function updateStars() {
    // J2000 = 2000-01-01 12:00 UTC = Unix ms 946728000000. T in days from J2000 (UT).
    var Tdays = (timeRef.gameTime / 86400000) - 10957.5;
    if (sun.year !== epochYear) {
        epochYear = sun.year;
        precessCatalog((epochYear + 0.5 - 2000) / 100);
    }
    var gmst = 18.697374558 + 24.06570982441908 * Tdays;
    var lst = gmst + sun.lon / 15;
    var latRad = sun.lat * Math.PI / 180;
    var sinLat = Math.sin(latRad), cosLat = Math.cos(latRad);
    for (var i = 0; i < STARS.length; i++) {
        var decRad = decDate[i];
        var H = (lst - raDate[i]) * 15 * Math.PI / 180;
        var sinDec = Math.sin(decRad), cosDec = Math.cos(decRad);
        var sinH = Math.sin(H), cosH = Math.cos(H);
        var sinAlt = sinLat * sinDec + cosLat * cosDec * cosH;
        if (sinAlt > 1) sinAlt = 1; else if (sinAlt < -1) sinAlt = -1;
        var altRad = Math.asin(sinAlt);
        var azRad = Math.atan2(-cosDec * sinH, sinDec * cosLat - cosDec * sinLat * cosH);
        if (azRad < 0) azRad += 2 * Math.PI;
        starState[i].altRad = altRad;
        starState[i].azRad = azRad;
    }
    var TdaysTT = Tdays + deltaTSec(sun.year) / 86400;
    updatePlanets(TdaysTT, gmst, latRad, sun.lon);
    updateMoon(TdaysTT, gmst, latRad, sun.lon);
}

// 맨눈 한계등급: 어스름·달빛·구름에 따라 희미한 별부터 사라진다 (깊은 밤 바다 ≈ 6등급).
export function skyLimitMag(): number {
    var dark = -sun.altDeg / 18; if (dark < 0) dark = 0; else if (dark > 1) dark = 1;
    var lim = 1 + 5 * dark;
    if (moonState.altRad > 0) lim -= 1.8 * moonState.illumination * Math.min(1, moonState.altRad / 0.3);
    return lim - 1.5 * weather.cloudiness;   // 구름 덩어리 자체가 별을 가리므로(3D) 여기선 옅은 박무만
}

// 별 하나의 밝기(0~1.2): 등급(√flux 근사) × 한계등급 페이드 × 지평선 소광
export function starVisual(mag: number, altRad: number, lim: number): number {
    if (altRad <= 0) return 0;
    var f = lim - mag; if (f <= 0) return 0; if (f > 1) f = 1;
    var b = Math.pow(10, -0.2 * (mag - 1)); if (b > 1.2) b = 1.2;
    var ext = altRad / 0.2; if (ext > 1) ext = 1;
    return b * f * (0.3 + 0.7 * ext);
}

// B−V 색지수 → 은은한 별빛 색 (청백 ~ 주황)
export function starTint(bv: number, out: number[]) {
    var t = (bv + 0.3) / 2; if (t < 0) t = 0; else if (t > 1) t = 1;
    out[0] = 0.82 + 0.18 * Math.min(1, t * 2);
    out[1] = 0.88 + 0.08 * (1 - Math.abs(t - 0.4) * 2.5);
    out[2] = 1.0 - 0.4 * t;
}
