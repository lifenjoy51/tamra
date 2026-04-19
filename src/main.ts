import {
    SCR_W, SCR_H, SEA,
    TILE_SIZE, TILE_SHIFT, WORLD_TILES_X, WORLD_TILES_Y, WORLD_W, WORLD_H,
    BUF_TILES, SHIFT, SIZE, MASK,
    ORIGIN_LON, ORIGIN_LAT, DEG_PER_PIXEL,
    TIME_SPEED_MIN, TIME_SPEED_MAX,
} from './config';
import { canvas, ctx, imagedata, buf8, buf32 } from './canvas';
import {
    boat, ship, camera, input, uiFlags,
    wind, sail, current, wave, weather,
    sun, moonState,
    timeRef, frameStats,
    BASE_SAIL_SPEED, BASE_CAM_METERS, CAM_HEIGHT_MARGIN,
    FRAME_INTERVAL, FRAME_EPSILON,
} from './state';
import { heightMeters } from './terrain';
import { altitude, colormap, slotTiles, loadTile, ensureTilesLoaded, initTiles } from './tiles';
import { computeWind } from './physics/wind';
import { polarFor, computeSail, updateShipSpeed } from './physics/sail';
import { computeCurrent } from './physics/current';
import { computeWaves } from './physics/waves';
import { computeWeather } from './physics/weather';
import { computeSun } from './astronomy/sun';
import { STARS, starState, MILKYWAY, milkyState, starTwinklePhase, starTwinkleFreq, updateStars } from './astronomy/stars';
import { PLANETS, planetState } from './astronomy/planets';
import { updateMoon } from './astronomy/moon';
import {
    SKY_DAY_Z, SKY_DUSK_Z, SKY_NIGHT_Z,
    skyRow, skyGlowX, skyGlowY, skyGlow,
    updateSky, updateCloudMask, cloudAlphaAt, cloudFull, CLOUD_FULL_H,
} from './sky';
import { DrawVerticalLine, Render, PX_PER_RAD_H } from './render/voxel';
import { DrawBackground } from './render/background';
import { UpdateCamera, moveBoat } from './render/camera';
import { drawNearFog, drawPrecipitation, drawLightning } from './render/effects';
import { DrawMinimap, mmState, MM_STRIDE_MIN, MM_STRIDE_MAX } from './render/minimap';
import { DrawBoat, initBoatSprite, boatSprite } from './render/boat-sprite';
import { DrawSkyMap } from './render/skymap';

(async function () {

// Fog target: 바다 → 하늘색, 육지 → 어두운 회색 (실제 대기 원근감)
var FOG_SEA_R = 160, FOG_SEA_G = 185, FOG_SEA_B = 210;
var FOG_LAND_R = 90,  FOG_LAND_G = 100, FOG_LAND_B = 120;

// --- 초기 로드: tile_index + 시작 지역 5x5 + boat 스프라이트 ---
var startGx = 0, startGy = 0;
try {
    var tilesInit = await initTiles();
    startGx = tilesInit.startGx;
    startGy = tilesInit.startGy;
    await initBoatSprite();
    window.__startGx = startGx;
    window.__startGy = startGy;
    window.__altitude = altitude;
    window.__colormap = colormap;
} catch (e) {
    document.getElementById('loading').innerHTML =
        '로드 실패<br><br><small>터미널에서:<br>' +
        '<b>cd ~/works/tamra && npm run dev</b><br>' +
        '→ http://localhost:8089 접속</small>';
    return;
}

document.getElementById('loading').style.display = 'none';
canvas.style.display = 'block';
document.getElementById('hud').style.display = 'block';
var gameUiEl = document.getElementById('gameui');
gameUiEl.style.display = 'block';
var debugEl = document.getElementById('debug');
debugEl.style.display = 'block';

window.__wind = wind;

window.__sail = sail;
window.__current = current;
window.__wave = wave;

window.__weather = weather;
window.__stars = STARS;
window.__starState = starState;
window.__planets = PLANETS;
window.__planetState = planetState;
window.__moonState = moonState;
// debug: camera 전역 접근

// --- Boat (플레이어 조종 대상) ---
// gx, gy는 글로벌 월드 좌표 (0~WORLD_W, 0~WORLD_H). tile init 이후 주입
boat.gx = window.__startGx;
boat.gy = window.__startGy;
camera.x = boat.gx;
camera.y = boat.gy;
window.__boat = boat; // 디버그: 외부에서 위치 조작
window.__ship = ship;
window.__camera = camera;

// 디버그: 콘솔에서 시간 제어 (window.__advanceHours(10), window.__setTimeSpeed(1))
window.__advanceHours = function (h) { timeRef.gameTime += 3600000 * h; };
window.__setTimeSpeed = function (s) { timeRef.TIME_SPEED = s; };
window.__sun = sun;
window.__setGameTime = function (ms) { timeRef.gameTime = ms; };
window.__getGameTime = function () { return timeRef.gameTime; };

computeSun();

computeWind();

// --- Key handlers ---
// 회전(A/D) / 이동(W/S) 둘 다 키 누를 때마다 이산 1 단위 변화.
// hold 시 브라우저 auto-repeat로 연속 효과.
// 미니맵: -/= 로 축소/확대
var ROT_STEP = Math.PI / 180;  // 초기 1°, [ / ] 로 절반/두배
var MOVE_STEP = 1;             // 초기 1 world unit, , / . 로 절반/두배
var ROT_STEP_MIN = Math.PI / 1440, ROT_STEP_MAX = Math.PI / 4;   // 0.125° ~ 45°
var MOVE_STEP_MIN = 0.0625, MOVE_STEP_MAX = 64;                   // 1/16 ~ 64 unit

// --- Audio (Web Audio) ---
// 절차 생성 — 외부 asset 없음(단일 HTML 유지).
// 첫 키 입력 시 ctx.resume(). updateAudio()는 메인 루프 말미 훅.
var audio = {
    ctx: null, master: null, muted: false,
    waves: null, wavesGain: null, wavesFilter: null,
    wind: null, windGain: null, windFilter: null,
    noiseBuffer: null
};
try { audio.muted = localStorage.getItem('tamra_muted') === '1'; } catch (e) {}
window.__audio = audio;
function buildNoiseBuffer(ctx) {
    // ~4s white noise loop (pink-ish by lowpass on filter)
    var len = ctx.sampleRate * 4;
    var buf = ctx.createBuffer(1, len, ctx.sampleRate);
    var d = buf.getChannelData(0);
    // pink noise via Voss-McCartney (간이)
    var b0=0,b1=0,b2=0;
    for (var i = 0; i < len; i++) {
        var w = Math.random() * 2 - 1;
        b0 = 0.997 * b0 + w * 0.029591;
        b1 = 0.985 * b1 + w * 0.032534;
        b2 = 0.950 * b2 + w * 0.048056;
        d[i] = (b0 + b1 + b2) * 0.3;
    }
    return buf;
}
function initAudio() {
    if (audio.ctx) return;
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    var ctx = new AC();
    var master = ctx.createGain();
    master.gain.value = audio.muted ? 0 : 0.3;
    master.connect(ctx.destination);
    audio.noiseBuffer = buildNoiseBuffer(ctx);
    // Waves loop
    var waves = ctx.createBufferSource();
    waves.buffer = audio.noiseBuffer; waves.loop = true;
    var wf = ctx.createBiquadFilter();
    wf.type = 'lowpass'; wf.frequency.value = 300; wf.Q.value = 0.7;
    var wg = ctx.createGain(); wg.gain.value = 0.0;
    waves.connect(wf); wf.connect(wg); wg.connect(master); waves.start();
    // Wind loop
    var wind = ctx.createBufferSource();
    wind.buffer = audio.noiseBuffer; wind.loop = true;
    var wdf = ctx.createBiquadFilter();
    wdf.type = 'bandpass'; wdf.frequency.value = 600; wdf.Q.value = 3;
    var wdg = ctx.createGain(); wdg.gain.value = 0.0;
    wind.connect(wdf); wdf.connect(wdg); wdg.connect(master); wind.start();
    audio.ctx = ctx; audio.master = master;
    audio.waves = waves; audio.wavesFilter = wf; audio.wavesGain = wg;
    audio.wind = wind; audio.windFilter = wdf; audio.windGain = wdg;
}
function resumeAudio() {
    if (!audio.ctx) { initAudio(); return; }
    if (audio.ctx.state === 'suspended') audio.ctx.resume();
}
function setMuted(m) {
    audio.muted = m;
    try { localStorage.setItem('tamra_muted', m ? '1' : '0'); } catch (e) {}
    if (audio.master) audio.master.gain.setTargetAtTime(m ? 0 : 0.3, audio.ctx.currentTime, 0.05);
}
var lastFlapMs = -99999;
function updateAudio() {
    if (!audio.ctx) return;
    var t = audio.ctx.currentTime;
    // 파도: wind 기반(풍파) + 기본값. gain 0~0.35
    var wg = Math.min(0.35, (wind.speedMS / 25) + 0.05);
    audio.wavesGain.gain.setTargetAtTime(wg, t, 0.3);
    audio.wavesFilter.frequency.setTargetAtTime(250 + wind.speedMS * 15, t, 0.3);
    // 바람 whistle: 풍속↑ → gain↑, 주파수↑
    var wdg = Math.min(0.18, Math.max(0, (wind.speedMS - 4) / 40));
    audio.windGain.gain.setTargetAtTime(wdg, t, 0.3);
    audio.windFilter.frequency.setTargetAtTime(400 + wind.speedMS * 30, t, 0.3);
    // 돛 펄럭임: 돛 올리고 + AoA가 RUN(180° 근처)일 때 burst
    var sailActive = boat.sailUp && sail && sail.mode === 'RUN';
    var nowMs = performance.now();
    if (sailActive && nowMs - lastFlapMs > 1200 + Math.random() * 1800) {
        lastFlapMs = nowMs;
        flapBurst();
    }
}
function flapBurst() {
    if (!audio.ctx) return;
    var ctx = audio.ctx;
    var src = ctx.createBufferSource();
    src.buffer = audio.noiseBuffer; src.loop = false;
    src.playbackRate.value = 0.7;
    var f = ctx.createBiquadFilter();
    f.type = 'bandpass'; f.frequency.value = 800; f.Q.value = 1.5;
    var g = ctx.createGain();
    var t = ctx.currentTime;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.15, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.25);
    src.connect(f); f.connect(g); g.connect(audio.master);
    src.start(t, Math.random() * 2);
    src.stop(t + 0.3);
}
function uiBlip(freq) {
    if (!audio.ctx) return;
    var ctx = audio.ctx;
    var osc = ctx.createOscillator();
    osc.type = 'sine'; osc.frequency.value = freq;
    var g = ctx.createGain();
    var t = ctx.currentTime;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.12, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.09);
    osc.connect(g); g.connect(audio.master);
    osc.start(t); osc.stop(t + 0.1);
}

document.onkeydown = function(e) {
    resumeAudio();
    switch (e.keyCode) {
        case 87: case 38: // W, Up: 돛 펼침
            if (!boat.sailUp) uiBlip(520);
            boat.sailUp = true;
            break;
        case 83: case 40: // S, Down: 돛 접음
            if (boat.sailUp) uiBlip(340);
            boat.sailUp = false;
            break;
        case 65: case 37: boat.angle += ROT_STEP; break; // A, Left
        case 68: case 39: boat.angle -= ROT_STEP; break; // D, Right
        case 187: // '=' / '+' : 미니맵 확대
            mmState.stride = Math.max(MM_STRIDE_MIN, mmState.stride / 1.5);
            break;
        case 189: // '-' : 미니맵 축소
            mmState.stride = Math.min(MM_STRIDE_MAX, mmState.stride * 1.5);
            break;
        case 188: // ',' : 이동 속도 ÷2
            MOVE_STEP = Math.max(MOVE_STEP_MIN, MOVE_STEP / 2);
            break;
        case 190: // '.' : 이동 속도 ×2
            MOVE_STEP = Math.min(MOVE_STEP_MAX, MOVE_STEP * 2);
            break;
        case 219: // '[' : 회전 속도 ÷2
            ROT_STEP = Math.max(ROT_STEP_MIN, ROT_STEP / 2);
            break;
        case 221: // ']' : 회전 속도 ×2
            ROT_STEP = Math.min(ROT_STEP_MAX, ROT_STEP * 2);
            break;
        case 84: // 'T' : 시간 감속 ÷2
            timeRef.TIME_SPEED = Math.max(TIME_SPEED_MIN, timeRef.TIME_SPEED / 2);
            uiBlip(440);
            break;
        case 89: // 'Y' : 시간 가속 ×2
            timeRef.TIME_SPEED = Math.min(TIME_SPEED_MAX, timeRef.TIME_SPEED * 2);
            uiBlip(660);
            break;
        case 75: // 'K' : 별자리 전체 뷰 토글
            uiFlags.skyMapOn = !uiFlags.skyMapOn;
            break;
        case 77: // 'M' : 음소거 토글
            setMuted(!audio.muted);
            break;
    }
    e.preventDefault();
    return false;
};

document.onkeyup = function(e) {
    return false;
};
// 첫 포인터 제스처에서도 AudioContext resume (iOS Safari 대응)
document.addEventListener('pointerdown', resumeAudio, { once: false });


// --- Main Draw loop (20fps cap) ---
// rAF 주기(16.67ms)의 정수배 근처에서 지터로 인한 fps 진동을 막기 위해
// EPSILON(8ms ≈ rAF 주기 절반)만큼 여유를 주고, lastDrawTime을 now로 리셋.

function UpdateDebug() {
    var tx = Math.floor(boat.gx / TILE_SIZE);
    var ty = Math.floor(boat.gy / TILE_SIZE);
    var slot = (ty % BUF_TILES) * BUF_TILES + (tx % BUF_TILES);
    var angDeg = (((boat.angle * 180 / Math.PI) % 360) + 360) % 360;
    var bOff = ((Math.floor(boat.gy) & MASK) << SHIFT) + (Math.floor(boat.gx) & MASK) | 0;
    var bAlt = altitude[bOff];
    var loaded = 0;
    for (var si = 0; si < slotTiles.length; si++) if (slotTiles[si] !== null) loaded++;
    var windDeg = (wind.angleRad * 180 / Math.PI) % 360;
    var wDegStr = ((windDeg | 0) + 1000).toString().slice(1);
    var latStr = Math.abs(sun.lat).toFixed(2) + '°' + (sun.lat >= 0 ? 'N' : 'S');
    var lonStr = Math.abs(sun.lon).toFixed(2) + '°' + (sun.lon >= 0 ? 'E' : 'W');
    var hh = Math.floor(sun.hourLocal);
    var mm = Math.floor((sun.hourLocal - hh) * 60);
    var hhmm = (hh < 10 ? '0' : '') + hh + ':' + (mm < 10 ? '0' : '') + mm;

    // 게임 UI: 월/일 + 시:분 (인게임 시각 표시)
    gameUiEl.textContent = sun.month + '월 ' + sun.date + '일  ' + hhmm;

    debugEl.textContent =
        'Tile:    ' + tx + ',' + ty + ' (slot ' + slot + ')\n' +
        'Pos:     ' + (boat.gx | 0) + ',' + (boat.gy | 0) + '\n' +
        'LatLon:  ' + latStr + ', ' + lonStr + '\n' +
        'Time:    ' + hhmm + '  (x' + timeRef.TIME_SPEED + ')\n' +
        'Sun:     alt ' + sun.altDeg.toFixed(0) + '°, az ' + sun.azDeg.toFixed(0) + '°\n' +
        'Ang:     ' + (angDeg | 0) + '°\n' +
        'Alt:     ' + bAlt + (bAlt <= SEA ? ' (sea)' : ' (land)') + '\n' +
        'CamH:    ' + camera.heightMeters.toFixed(1) + 'm\n' +
        'Wind:    ' + wDegStr + '° / ' + wind.speedMS.toFixed(1) + ' m/s\n' +
        'Sail:    ' + (boat.sailUp ? 'UP  ' : 'DOWN') + ' ' + (sail.polar * 100 | 0) + '% ' + sail.mode + ' (w×' + sail.windFactor.toFixed(2) + ')\n' +
        'Ship:    ' + ship.groundMS.toFixed(2) + ' m/s (' + (ship.groundMS * 3.6).toFixed(1) + ' km/h)\n' +
        'Cur:     ' + (((current.angleRad * 180 / Math.PI) | 0) + 1000).toString().slice(1) + '° / ' + current.speedMS.toFixed(2) + ' m/s\n' +
        'Sky:     cloud ' + (weather.cloudiness * 100 | 0) + '% / vis ×' + weather.visibilityCoef.toFixed(2) + '\n' +
        'Step:    ' + MOVE_STEP + 'u / ' + (ROT_STEP * 180 / Math.PI).toFixed(2) + '°\n' +
        'Tiles:   ' + loaded + '/' + slotTiles.length + '\n' +
        'MMZoom:  1:' + mmState.stride + '\n' +
        'FPS:     ' + frameStats.fpsCurrent + '\n' +
        'Frame:   ' + frameStats.frameTimeEma.toFixed(2) + 'ms';
}

function Draw(now) {
    window.requestAnimationFrame(Draw);
    if (now === undefined) now = performance.now();
    if (now - frameStats.lastDrawTime < FRAME_INTERVAL - FRAME_EPSILON) return;
    frameStats.lastDrawTime = now;

    var frameStart = performance.now();
    UpdateCamera();
    wave.time += 0.04;
    DrawBackground();
    Render();
    drawNearFog();
    drawPrecipitation();
    drawLightning();
    updateAudio();
    DrawMinimap();
    DrawBoat();
    DrawSkyMap();
    var frameDur = performance.now() - frameStart;
    // EMA alpha=0.1 — 약 10프레임 윈도우
    frameStats.frameTimeEma = frameStats.frameTimeEma === 0 ? frameDur : frameStats.frameTimeEma * 0.9 + frameDur * 0.1;

    // FPS 1초 간격 갱신
    frameStats.fpsFrames++;
    if (frameStats.fpsStart === 0) frameStats.fpsStart = now;
    if (now - frameStats.fpsStart >= 1000) {
        frameStats.fpsCurrent = Math.round(frameStats.fpsFrames * 1000 / (now - frameStats.fpsStart));
        frameStats.fpsFrames = 0;
        frameStats.fpsStart = now;
    }
    UpdateDebug();
}

// Initial render
Draw();
})();
