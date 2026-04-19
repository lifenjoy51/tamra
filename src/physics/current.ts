// current.ts — 대양 대순환 근사 (적도류/아열대/편서풍 + 쿠로시오·동호주)
// flow direction: 0 = 북쪽으로 흐름, π/2 = 동쪽으로 흐름
import { current, sun } from '../state';

export function computeCurrent() {
    var lat = sun.lat, lon = sun.lon;
    var a = Math.abs(lat);
    var dir, spd;
    if      (a < 20) { dir = 270; spd = 0.4; }    // 적도류 (W)
    else if (a < 35) { dir = 90;  spd = 0.2; }    // 아열대 환류 동쪽 가장자리
    else if (a < 55) { dir = 90;  spd = 0.3; }    // 편서풍대 (북태평양)
    else if (a < 65) { dir = 270; spd = 0.2; }    // 아극지 반류
    else             { dir = 90;  spd = 0.1; }    // 극지

    // 서안경계류 — 쿠로시오 (아시아 동안, 북반구)
    if (lon > 110 && lon < 150 && lat > 20 && lat < 45) {
        dir = 45; spd = 1.2;
    }
    // 남반구 대칭 (동호주 해류)
    if (lon > 140 && lon < 170 && lat > -45 && lat < -20) {
        dir = 225; spd = 1.0;
    }

    // 결정적 noise (위치·년도)
    var seed = (Math.floor(lat * 2) + Math.floor(lon * 2) * 11 + sun.year * 7) >>> 0;
    var n = ((seed * 2654435761) >>> 0) / 4294967295;
    dir += (n - 0.5) * 20;
    spd *= 0.8 + n * 0.4;

    dir = ((dir % 360) + 360) % 360;
    current.angleRad = dir * Math.PI / 180;
    current.speedMS = spd;
}
