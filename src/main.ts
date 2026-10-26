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
    wind, sail, current, tide, wave, weather,
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
import { STARS, starState, starTwinklePhase, starTwinkleFreq, updateStars } from './astronomy/stars';
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
import { DrawMinimap, initMinimapOverlay, setMinimapVisible, mmState, MM_STRIDE_MIN, MM_STRIDE_MAX } from './render/minimap';
import { DrawBoat, initBoatSprite, boatSprite } from './render/boat-sprite';
import { DrawSkyMap } from './render/skymap';
import { updateAudio } from './audio';
import { initInput, inputState } from './input';
import { initRudderUI, updateRudderUI } from './ui/rudder';
import { initSailUI, updateSailUI } from './ui/sail';
import { initToggleUI, updateToggleUI } from './ui/toggle';
import { initSoundingUI } from './ui/sounding';
import { initDebugPanel } from './ui/debug-panel';
import { showStartMenu } from './ui/start-menu';
import { initDebugHooks } from './debug';
import { init3D, Draw3D, canvas3d } from './render3d/index';

(async function () {

// --- 초기 로드: tile_index + 시작 지역 5x5 + boat 스프라이트 ---
var startGx = 0, startGy = 0, startAngle = 0;
try {
    var tilesInit = await initTiles();
    startGx = tilesInit.startGx;
    startGy = tilesInit.startGy;
    startAngle = tilesInit.startAngle;
    await initBoatSprite();
} catch (e) {
    document.getElementById('loading').innerHTML =
        '로드 실패<br><br><small>터미널에서:<br>' +
        '<b>cd ~/works/tamra && npm run dev</b><br>' +
        '→ http://localhost:8089 접속</small>';
    return;
}

document.getElementById('loading').style.display = 'none';

// 시작 메뉴 노출 — 사용자가 "항해 시작" 또는 아무 키를 누를 때까지 대기.
await showStartMenu();

canvas.style.display = 'block';
var gameUiEl = document.getElementById('gameui');
gameUiEl.style.display = 'block';
var debugEl = document.getElementById('debug');
var debugTextEl = document.getElementById('debug-text');
var dbgTimeVal = document.getElementById('dbg-time-val');
var dbgMapVal = document.getElementById('dbg-map-val');

// --- Boat (플레이어 조종 대상) ---
// gx, gy는 글로벌 월드 좌표 (0~WORLD_W, 0~WORLD_H). tile init 이후 주입
boat.gx = startGx;
boat.gy = startGy;
boat.angle = startAngle;
camera.x = boat.gx;
camera.y = boat.gy;
camera.angle = boat.angle;

computeSun();
computeWind();
// 시작 메뉴에서 대기한 실제 시간(수초~수분)이 dtMs 로 들어가면 TIME_SPEED 배속과 곱해져
// 첫 프레임에 배가 순식간에 먼 바다로 순간이동해버린다 — 메뉴 종료 시점으로 리셋.
frameStats.lastMoveTime = Date.now();

initInput();
initMinimapOverlay();
initRudderUI();
initSailUI();
initToggleUI();
initSoundingUI();
initDebugPanel();
initDebugHooks();

// --- Main Draw loop (20fps cap) ---
// rAF 주기(16.67ms)의 정수배 근처에서 지터로 인한 fps 진동을 막기 위해
// EPSILON(8ms ≈ rAF 주기 절반)만큼 여유를 주고, lastDrawTime을 now로 리셋.

function UpdateDebug() {
    var tx = Math.floor(boat.gx / TILE_SIZE);
    var ty = Math.floor(boat.gy / TILE_SIZE);
    var windDeg = (wind.angleRad * 180 / Math.PI) % 360;
    var wDegStr = ((windDeg | 0) + 1000).toString().slice(1);
    var latStr = Math.abs(sun.lat).toFixed(2) + '°' + (sun.lat >= 0 ? 'N' : 'S');
    var lonStr = Math.abs(sun.lon).toFixed(2) + '°' + (sun.lon >= 0 ? 'E' : 'W');

    gameUiEl.textContent = sun.month + '/' + sun.date;

    debugTextEl.textContent =
        'Wind:    ' + wDegStr + '° / ' + wind.speedMS.toFixed(1) + ' m/s\n' +
        'Cur:     ' + (((current.angleRad * 180 / Math.PI) | 0) + 1000).toString().slice(1) + '° / ' + current.speedMS.toFixed(2) + ' m/s (해류 ' + current.streamMS.toFixed(2) + ')\n' +
        'Tide:    ' + (tide.heightM >= 0 ? '+' : '') + tide.heightM.toFixed(2) + ' m  조차 ' + tide.rangeM.toFixed(1) + '/' + tide.springRangeM.toFixed(1) + ' m  조류 ' + tide.flowMS.toFixed(2) + ' m/s ' + (((tide.flowDirRad * 180 / Math.PI) | 0) + 1000).toString().slice(1) + '°  수심 ' + (tide.depthM | 0) + 'm\n' +
        'Press:   ' + (wind.pressure >= 0 ? '+' : '') + wind.pressure.toFixed(1) + ' hPa' + (wind.typhoonKm < 3000 ? '  태풍 ' + (wind.typhoonKm | 0) + 'km' : '') + '\n' +
        'Swell:   from ' + (((wave.swellFromRad * 180 / Math.PI) | 0) + 1000).toString().slice(1) + '° / Hs ' + wave.swellHs.toFixed(1) + ' m\n' +
        'Sky:     cloud ' + (weather.cloudiness * 100 | 0) + '% / vis ×' + weather.visibilityCoef.toFixed(2) + (weather.fog > 0.05 ? ' / 해무 ' + (weather.fog * 100 | 0) + '%' : '') + '\n' +
        'Sail:    ' + (boat.sail === 0 ? 'DOWN' : boat.sail === 0.5 ? 'HALF' : 'FULL') + ' ' + (sail.polar * 100 | 0) + '% ' + sail.mode + ' (w×' + sail.windFactor.toFixed(2) + ')' + (boat.row ? ' +ROW' : '') + '\n' +
        'Ship:    ' + (ship.groundMS * 3.6).toFixed(1) + ' km/h / ' + (((ship.groundDirRad * 180 / Math.PI) | 0) + 1000).toString().slice(1) + '°' +
            (ship.moveScale < timeRef.TIME_SPEED - 0.5 ? '  move×' + ship.moveScale.toFixed(ship.moveScale < 10 ? 1 : 0) + ' (해안 ' + (ship.nearLandM | 0) + 'm)' : '') + '\n' +
        'Tile:    ' + tx + ',' + ty + '  (' + (boat.gx | 0) + ',' + (boat.gy | 0) + ')\n' +
        'LatLon:  ' + latStr + ', ' + lonStr + '\n' +
        'FPS:     ' + frameStats.fpsCurrent + ' / ' + frameStats.frameTimeEma.toFixed(2) + 'ms';
    dbgTimeVal.textContent = '×' + timeRef.TIME_SPEED;
    dbgMapVal.textContent = 'stride ' + mmState.stride.toFixed(2);
}

function Draw(now) {
    window.requestAnimationFrame(Draw);
    if (now === undefined) now = performance.now();
    if (now - frameStats.lastDrawTime < FRAME_INTERVAL - FRAME_EPSILON) return;
    frameStats.lastDrawTime = now;

    var frameStart = performance.now();
    UpdateCamera();
    wave.time += 0.04;
    if (uiFlags.render3d && uiFlags.skyMapOn) {
        // 하늘보기는 2D 캔버스(ctx)에 그리는 오버레이 — 3D 모드에선 2D 캔버스를 비우고 단독으로 띄운다.
        canvas3d.style.display = 'none';
        canvas.style.display = 'block';
        ctx.clearRect(0, 0, SCR_W, SCR_H);
        DrawSkyMap();
    } else if (uiFlags.render3d && Draw3D()) {
        canvas.style.display = 'none';
        canvas3d.style.display = 'block';
    } else {
        // render3d 꺼짐 또는 WebGL 초기화 실패 → 2D voxel 폴백 (실패 시 플래그도 내려 매 프레임 재시도 방지).
        uiFlags.render3d = false;
        canvas3d.style.display = 'none';
        canvas.style.display = 'block';
        DrawBackground();
        Render();
        drawNearFog();
        drawPrecipitation();
        drawLightning();
        DrawBoat();
        DrawSkyMap();
    }
    // 미니맵은 디버그 패널과 연동(패널 숨기면 미니맵도 숨김) — 2D/3D 어느 렌더러든 오버레이로 표시.
    setMinimapVisible(uiFlags.debugVisible);
    if (uiFlags.debugVisible) DrawMinimap();
    updateAudio();
    updateRudderUI();
    updateSailUI();
    updateToggleUI();
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
