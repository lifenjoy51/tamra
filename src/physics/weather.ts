// weather.ts — ITCZ + 중위도 storm + 아열대 고기압 + 노이즈 → cloudiness/visibility/precipitation.
// __cloudOverride / __precipOverride / __precipTypeOverride 디버그 hook 보존.
import { weather, sun } from '../state';

export function computeWeather() {
    var lat = sun.lat;
    var a = Math.abs(lat);
    var base = 0.2;
    // ITCZ (적도 수렴대, 계절 shift)
    var shift = 5 * Math.sin(2 * Math.PI * (sun.dayOfYear - 81) / 365);
    if (Math.abs(lat - shift) < 10) base += 0.5;
    // 중위도 폭풍대
    if (a > 40 && a < 60) base += 0.3;
    // 아열대 고기압대 (맑음)
    if (a > 22 && a < 35) base -= 0.15;
    // 결정적 noise (위치·날짜·년도)
    var seed = (Math.floor(lat * 3) + Math.floor(sun.lon * 3) * 13 + Math.floor(sun.dayOfYear / 3) * 7 + sun.year * 29) >>> 0;
    var n = ((seed * 2654435761) >>> 0) / 4294967295;
    base += (n - 0.5) * 0.4;
    // 일변화 (낮 대류 증가)
    base += Math.sin((sun.hourLocal - 6) * Math.PI / 12) * 0.08;
    if (base < 0) base = 0; else if (base > 1) base = 1;
    weather.cloudiness = base;
    weather.visibilityCoef = 1.0 - base * 0.5;
    // 강수: cloudiness > 0.6 구간에서 선형 증가, 1.0까지. 위도 높으면 눈.
    weather.precipitation = base > 0.6 ? (base - 0.6) / 0.35 : 0;
    if (weather.precipitation > 1) weather.precipitation = 1;
    weather.precipType = (a > 45 || (a > 35 && sun.dayOfYear < 80) || (a > 35 && sun.dayOfYear > 300)) ? 'snow' : 'rain';
    if (typeof window.__cloudOverride === 'number') {
        weather.cloudiness = window.__cloudOverride;
        weather.visibilityCoef = 1.0 - weather.cloudiness * 0.5;
    }
    if (typeof window.__precipOverride === 'number') {
        weather.precipitation = window.__precipOverride;
    }
    if (typeof window.__precipTypeOverride === 'string') {
        weather.precipType = window.__precipTypeOverride;
    }
}
