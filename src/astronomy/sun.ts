// sun.ts — 태양 적위/고도/방위 계산 (근사식 + 보정 무시)
// 보트 위치 → 위/경도, gameTime → dayOfYear/solarH → alt/az.
import { ORIGIN_LAT, ORIGIN_LON, DEG_PER_PIXEL } from '../config';
import { boat, sun, timeRef } from '../state';

export function computeSun() {
    // 보트 위치 → 위/경도
    var lat = ORIGIN_LAT - boat.gy * DEG_PER_PIXEL;
    var lon = ORIGIN_LON + boat.gx * DEG_PER_PIXEL;
    lon = ((lon + 180) % 360 + 360) % 360 - 180;
    sun.lat = lat;
    sun.lon = lon;

    var d = new Date(timeRef.gameTime);
    var yearStart = Date.UTC(d.getUTCFullYear(), 0, 0);
    var dayOfYear = Math.floor((timeRef.gameTime - yearStart) / 86400000);

    // 태양 적위 (declination) — 근사식
    var dec = 23.44 * Math.PI/180 * Math.sin(2 * Math.PI * (dayOfYear - 81) / 365);

    // 로컬 태양시 (경도 보정, 시정차 무시)
    var utcH = d.getUTCHours() + d.getUTCMinutes()/60 + d.getUTCSeconds()/3600;
    var solarH = utcH + lon / 15;
    var H = (solarH - 12) * 15 * Math.PI/180;  // 시간각 (rad)

    var latRad = lat * Math.PI/180;
    var sinAlt = Math.sin(latRad) * Math.sin(dec) + Math.cos(latRad) * Math.cos(dec) * Math.cos(H);
    if (sinAlt > 1) sinAlt = 1; else if (sinAlt < -1) sinAlt = -1;
    var altRad = Math.asin(sinAlt);
    // 방위: 0=북, π/2=동 (표준)
    var azRad = Math.atan2(
        -Math.cos(dec) * Math.sin(H),
         Math.sin(dec) * Math.cos(latRad) - Math.cos(dec) * Math.sin(latRad) * Math.cos(H)
    );
    if (azRad < 0) azRad += 2 * Math.PI;

    sun.altRad = altRad;
    sun.azRad = azRad;
    sun.altDeg = altRad * 180/Math.PI;
    sun.azDeg = azRad * 180/Math.PI;
    sun.dayOfYear = dayOfYear;
    sun.hourLocal = ((solarH % 24) + 24) % 24;
    sun.month = d.getUTCMonth() + 1;
    sun.date = d.getUTCDate();
    sun.year = d.getUTCFullYear();
}
