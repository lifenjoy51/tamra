// debug.ts — window.__* DevTools 인터페이스 집결.
// 기존 단일 HTML 에서 여러 곳에 흩어져 있던 등록을 한 함수로 묶음. 이름·시그니처 무변경.
// ex) window.__boat, window.__advanceHours(10), window.__setTimeSpeed(1) 등.
import {
    boat, ship, camera,
    wind, sail, current, wave, weather,
    sun, moonState,
    timeRef,
} from './state';
import { altitude, colormap } from './tiles';
import { STARS, starState } from './astronomy/stars';
import { PLANETS, planetState } from './astronomy/planets';
import { audio, setAudioGain } from './audio';

export function initDebugHooks() {
    var w = window as any;
    // state 싱글톤
    w.__boat = boat;
    w.__ship = ship;
    w.__camera = camera;
    w.__wind = wind;
    w.__sail = sail;
    w.__current = current;
    w.__wave = wave;
    w.__weather = weather;
    w.__sun = sun;
    w.__moonState = moonState;
    // astronomy 테이블
    w.__stars = STARS;
    w.__starState = starState;
    w.__planets = PLANETS;
    w.__planetState = planetState;
    // tiles
    w.__altitude = altitude;
    w.__colormap = colormap;
    // audio
    w.__audio = audio;
    w.__audioGain = setAudioGain;
    // 시간 제어 (콘솔에서 시간 점프/속도 조작)
    w.__advanceHours = function (h) { timeRef.gameTime += 3600000 * h; };
    w.__setTimeSpeed = function (s) { timeRef.TIME_SPEED = s; };
    w.__setGameTime = function (ms) { timeRef.gameTime = ms; };
    w.__getGameTime = function () { return timeRef.gameTime; };
}
