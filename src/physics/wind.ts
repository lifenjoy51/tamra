// wind.ts — 배 위치의 바람 (synoptic.ts 연속 기상장 샘플).
// wind.angleRad: 불어오는 방위 (0 = 북, π/2 = 동). pressure: 기압 편차(hPa), typhoonKm: 가장 가까운 태풍 중심.
import { wind, sun, timeRef } from '../state';
import { windAt, WindSample } from './synoptic';

const ws: WindSample = { u: 0, v: 0, pressure: 0, typhoonKm: 1e9 };

export function computeWind() {
    windAt(sun.lat, sun.lon, timeRef.gameTime / 3.6e6, ws);
    var spd = Math.hypot(ws.u, ws.v);
    var from = Math.atan2(-ws.u, -ws.v);
    if (from < 0) from += 2 * Math.PI;
    wind.angleRad = from;
    wind.speedMS = spd;
    wind.pressure = ws.pressure;
    wind.typhoonKm = ws.typhoonKm;
}
