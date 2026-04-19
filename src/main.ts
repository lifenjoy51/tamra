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
import { updateAudio } from './audio';
import { initInput, inputState } from './input';
import { initDebugHooks } from './debug';

(async function () {

// --- 초기 로드: tile_index + 시작 지역 5x5 + boat 스프라이트 ---
var startGx = 0, startGy = 0;
try {
    var tilesInit = await initTiles();
    startGx = tilesInit.startGx;
    startGy = tilesInit.startGy;
    await initBoatSprite();
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

// --- Boat (플레이어 조종 대상) ---
// gx, gy는 글로벌 월드 좌표 (0~WORLD_W, 0~WORLD_H). tile init 이후 주입
boat.gx = startGx;
boat.gy = startGy;
camera.x = boat.gx;
camera.y = boat.gy;

computeSun();
computeWind();

initInput();
initDebugHooks();

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
        'Step:    ' + inputState.moveStep + 'u / ' + (inputState.rotStep * 180 / Math.PI).toFixed(2) + '°\n' +
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
