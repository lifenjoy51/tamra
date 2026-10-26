// weather.ts — 배 위치의 하늘 (synoptic.ts 연속 기상장 샘플) → cloudiness/visibility/precipitation/fog.
// __cloudOverride / __precipOverride / __precipTypeOverride 디버그 hook 보존.
import { weather, sun, timeRef } from '../state';
import { WEATHER_DIURNAL_PHASE_HOURS, WEATHER_DIURNAL_AMP } from '../config';
import { skyAt, SkySample } from './synoptic';

const sk: SkySample = { cloud: 0, precip: 0, fog: 0 };

export function computeWeather() {
    var a = Math.abs(sun.lat);
    skyAt(sun.lat, sun.lon, timeRef.gameTime / 3.6e6, sk);
    // 일변화 (낮 대류 증가)
    var base = sk.cloud + Math.sin((sun.hourLocal - WEATHER_DIURNAL_PHASE_HOURS) * Math.PI / 12) * WEATHER_DIURNAL_AMP;
    if (base < 0) base = 0; else if (base > 1) base = 1;
    weather.cloudiness = base;
    weather.precipitation = sk.precip;
    // 해무는 새벽에 짙고 한낮에 옅다
    var fog = sk.fog * (0.75 + 0.25 * Math.cos((sun.hourLocal - 5) * Math.PI / 12));
    weather.fog = fog;
    weather.visibilityCoef = Math.min(1.0 - base * 0.5 - sk.precip * 0.2, 1 - 0.96 * fog);
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
