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
import { altitude, colormap, slotTiles, loadImage, loadTile, ensureTilesLoaded, initTiles } from './tiles';
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

(async function () {

// Fog target: 바다 → 하늘색, 육지 → 어두운 회색 (실제 대기 원근감)
var FOG_SEA_R = 160, FOG_SEA_G = 185, FOG_SEA_B = 210;
var FOG_LAND_R = 90,  FOG_LAND_G = 100, FOG_LAND_B = 120;

// --- 초기 로드: tile_index + 시작 지역 5x5 + boat 스프라이트 ---
var boatImg;
var startGx = 0, startGy = 0;
try {
    var tilesInit = await initTiles();
    startGx = tilesInit.startGx;
    startGy = tilesInit.startGy;
    boatImg = await loadImage('boat.png');
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
var minimapStride = 24;
var MM_STRIDE_MIN = 0.25, MM_STRIDE_MAX = 2048;

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
            minimapStride = Math.max(MM_STRIDE_MIN, minimapStride / 1.5);
            break;
        case 189: // '-' : 미니맵 축소
            minimapStride = Math.min(MM_STRIDE_MAX, minimapStride * 1.5);
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

// --- Precipitation (비·눈 파티클) ---
// 사전 할당 ~300개. 화면 좌표계에서 직접 이동/그리기 → 저비용.
// precipitation=0이면 drawPrecipitation 즉시 리턴.
var PRECIP_MAX = 300;
var precipX = new Float32Array(PRECIP_MAX);
var precipY = new Float32Array(PRECIP_MAX);
(function initPrecip() {
    for (var i = 0; i < PRECIP_MAX; i++) {
        precipX[i] = Math.random() * SCR_W;
        precipY[i] = Math.random() * SCR_H;
    }
})();
function drawPrecipitation() {
    var intensity = weather.precipitation;
    if (intensity <= 0.001) return;
    var isSnow = weather.precipType === 'snow';
    var active = (PRECIP_MAX * intensity) | 0;
    // 바람 기반 경사: 풍속·풍향 일부 반영. 화면 상 x축 방향 성분만 쓰면 과함 → 완만히.
    // wind.angleRad: 0=북(바람이 북에서 불어옴). 동쪽 성분 = -sin(angleRad)*speed
    var windX = -Math.sin(wind.angleRad) * wind.speedMS;
    var driftX = windX * 0.18;             // px/frame 근사
    var fallY = isSnow ? 1.2 : 5.5;        // 눈은 느리게, 비는 빠르게
    // 지평선 아래엔 안 떨어짐(배/바다 위로 보이는 효과는 없으니 전 화면 허용)
    var rainCol = 0xFFE0C89C;   // light blue-gray (BGR)
    var snowCol = 0xFFF0F0FF;
    for (var i = 0; i < active; i++) {
        var x = precipX[i] + driftX;
        var y = precipY[i] + fallY;
        if (y >= SCR_H || x < 0 || x >= SCR_W) {
            // 재생성: 화면 위쪽 랜덤
            x = Math.random() * SCR_W;
            y = Math.random() * -SCR_H * 0.25;
        }
        precipX[i] = x;
        precipY[i] = y;
        var ix = x | 0, iy = y | 0;
        if (iy < 0 || iy >= SCR_H || ix < 0 || ix >= SCR_W) continue;
        if (isSnow) {
            buf32[iy * SCR_W + ix] = snowCol;
        } else {
            // 비: 짧은 3px 사선 (driftX 방향)
            var dxSign = driftX < 0 ? -1 : 1;
            for (var k = 0; k < 3; k++) {
                var lx = ix - k * dxSign;
                var ly = iy - k;
                if (ly < 0 || ly >= SCR_H || lx < 0 || lx >= SCR_W) break;
                buf32[ly * SCR_W + lx] = rainCol;
            }
        }
    }
}

// --- Near-distance fog (저시정 안개) ---
// visibilityCoef < 0.7 일 때 전체 화면에 옅은 회백색 veil 덧입힘.
// Render()의 거리 fog와 별개로, 근거리까지 감소된 시정을 강화.
function drawNearFog() {
    var vis = weather.visibilityCoef;
    if (vis >= 0.7) return;
    // strength: vis 0.7→0, 0.3→0.4
    var strength = (0.7 - vis) * 1.0;
    if (strength > 0.5) strength = 0.5;
    // 안개 색: 주간 = 연회색, 야간 = 짙은 청색
    var fR, fG, fB;
    if (sun.altDeg > 5) { fR = 200; fG = 200; fB = 205; }
    else if (sun.altDeg > -6) { fR = 140; fG = 130; fB = 130; }
    else { fR = 30; fG = 34; fB = 44; }
    var total = SCR_W * SCR_H;
    for (var i = 0; i < total; i++) {
        var bg = buf32[i];
        var bR = bg & 0xFF, bG = (bg >> 8) & 0xFF, bB = (bg >> 16) & 0xFF;
        var nR = (bR + (fR - bR) * strength) | 0;
        var nG = (bG + (fG - bG) * strength) | 0;
        var nB = (bB + (fB - bB) * strength) | 0;
        buf32[i] = 0xFF000000 | (nB << 16) | (nG << 8) | nR;
    }
}

// --- Lightning flash (뇌전) ---
// cloudiness > 0.85 일 때 결정적 gate 로 드문드문 플래시.
// gameTime을 30초 bucket으로 나눠 hash → 확률 체크. flash 길이 ≤ 120ms (real time).
var lightningLastRealMs = -99999;
function drawLightning() {
    if (weather.cloudiness <= 0.85) return;
    // bucket: 30s 게임시간 단위로 이벤트 발생 여부 결정
    var bucket = (timeRef.gameTime / 30000) | 0;
    var h = ((bucket * 2654435761) >>> 0) / 4294967295;  // 0..1
    // cloudiness 0.85~1.0 → 확률 0.05~0.25
    var prob = (weather.cloudiness - 0.85) * 1.3 + 0.05;
    var shouldFlash = h < prob;
    var nowMs = performance.now();
    if (shouldFlash && nowMs - lightningLastRealMs > 1500) {
        lightningLastRealMs = nowMs;
    }
    var elapsed = nowMs - lightningLastRealMs;
    if (elapsed > 120) return;
    // 플래시 강도: 0~50ms 강, 50~120ms 감쇠
    var strength = elapsed < 50 ? (0.55 - elapsed / 50 * 0.25) : (0.3 * (1 - (elapsed - 50) / 70));
    if (strength <= 0) return;
    // 하늘 영역(horizon 위)만 백색 섞기, 지표는 약하게
    var horizonY = (camera && camera.horizon) ? camera.horizon : (SCR_H * 0.5) | 0;
    for (var y = 0; y < SCR_H; y++) {
        var k = y < horizonY ? strength : strength * 0.35;
        var base = y * SCR_W;
        for (var x = 0; x < SCR_W; x++) {
            var bg = buf32[base + x];
            var bR = bg & 0xFF, bG = (bg >> 8) & 0xFF, bB = (bg >> 16) & 0xFF;
            var nR = (bR + (250 - bR) * k) | 0;
            var nG = (bG + (250 - bG) * k) | 0;
            var nB = (bB + (255 - bB) * k) | 0;
            buf32[base + x] = 0xFF000000 | (nB << 16) | (nG << 8) | nR;
        }
    }
}

// --- DrawMinimap (디버그용, 좌하단) ---
function DrawMinimap() {
    var MM_SIZE = 108;
    var MM_X = 6;
    var MM_Y = SCR_H - MM_SIZE - 6;
    var STRIDE = minimapStride; // 월드 픽셀/미니맵 픽셀 (- / = 키로 조절)

    // 테두리
    for (var i = -1; i <= MM_SIZE; i++) {
        if (MM_X + i >= 0 && MM_X + i < SCR_W) {
            if (MM_Y - 1 >= 0) buf32[(MM_Y - 1) * SCR_W + MM_X + i] = 0xFFC8C8C8;
            if (MM_Y + MM_SIZE < SCR_H) buf32[(MM_Y + MM_SIZE) * SCR_W + MM_X + i] = 0xFFC8C8C8;
        }
        if (MM_Y + i >= 0 && MM_Y + i < SCR_H) {
            if (MM_X - 1 >= 0) buf32[(MM_Y + i) * SCR_W + MM_X - 1] = 0xFFC8C8C8;
            if (MM_X + MM_SIZE < SCR_W) buf32[(MM_Y + i) * SCR_W + MM_X + MM_SIZE] = 0xFFC8C8C8;
        }
    }

    // 지형
    var half = MM_SIZE >> 1;
    for (var my = 0; my < MM_SIZE; my++) {
        var wy = (boat.gy + (my - half) * STRIDE) | 0;
        var rowBase = (MM_Y + my) * SCR_W + MM_X;
        for (var mx = 0; mx < MM_SIZE; mx++) {
            var wx = (boat.gx + (mx - half) * STRIDE) | 0;
            var off = ((wy & MASK) << SHIFT) + (wx & MASK);
            var alt = altitude[off];
            var c;
            if (alt <= SEA) {
                var d = SEA - alt;
                c = d > 20 ? 0xFF5A2818 : 0xFF8C3C20;
            } else {
                var a = alt - SEA;
                if      (a < 20)  c = 0xFF3A6840;
                else if (a < 60)  c = 0xFF3C5A70;
                else if (a < 120) c = 0xFF4878A0;
                else              c = 0xFFB0B0B0;
            }
            buf32[rowBase + mx] = c;
        }
    }

    // 타일 경계 (세로/가로 얇은 선)
    var centerTx = Math.floor(boat.gx / TILE_SIZE);
    var centerTy = Math.floor(boat.gy / TILE_SIZE);
    var gridC = 0xFF808080;
    for (var dt = -2; dt <= 2; dt++) {
        // 세로 경계
        var bdX = (centerTx + dt) * TILE_SIZE - boat.gx;
        var mmx = (half + bdX / STRIDE) | 0;
        if (mmx >= 0 && mmx < MM_SIZE) {
            for (var y = 0; y < MM_SIZE; y += 2) buf32[(MM_Y + y) * SCR_W + MM_X + mmx] = gridC;
        }
        // 가로 경계
        var bdY = (centerTy + dt) * TILE_SIZE - boat.gy;
        var mmy = (half + bdY / STRIDE) | 0;
        if (mmy >= 0 && mmy < MM_SIZE) {
            for (var x = 0; x < MM_SIZE; x += 2) buf32[(MM_Y + mmy) * SCR_W + MM_X + x] = gridC;
        }
    }

    // 보트 위치 (중앙) + 방향 화살표
    var cx = MM_X + half, cy = MM_Y + half;
    var RED = 0xFF0000FF;
    for (var dy = -1; dy <= 1; dy++)
        for (var dx = -1; dx <= 1; dx++)
            buf32[(cy + dy) * SCR_W + cx + dx] = RED;
    // 방향: 전진 방향이 -sin, -cos (UpdateCamera와 동일)
    var fx = -Math.sin(boat.angle), fy = -Math.cos(boat.angle);
    for (var k = 2; k <= 6; k++) {
        var px = (cx + fx * k) | 0;
        var py = (cy + fy * k) | 0;
        if (px >= MM_X && px < MM_X + MM_SIZE && py >= MM_Y && py < MM_Y + MM_SIZE)
            buf32[py * SCR_W + px] = RED;
    }
}

// --- DrawBoat (boat.png 스프라이트) ---
// --- 하늘보기 (polar azimuthal projection) ---
// 중심 = 천정, 외곽 = 지평선. 화면 위쪽 = 배 진행 방향.
// 낮엔 태양·하늘색, 밤엔 별. 토글 상태에선 시간 정지.
function DrawSkyMap() {
    if (!uiFlags.skyMapOn) return;
    var cx = SCR_W / 2;
    var cy = SCR_H / 2;
    var R = Math.min(SCR_W, SCR_H) / 2 - 14;

    // 하늘 색: 태양 고도 기반으로 낮·황혼·밤 blend (updateSky와 동일 규칙)
    var dayW   = (sun.altDeg - 5) / 10;     if (dayW < 0) dayW = 0;   else if (dayW > 1) dayW = 1;
    var nightW = (-6 - sun.altDeg) / 6;     if (nightW < 0) nightW = 0; else if (nightW > 1) nightW = 1;
    var duskW  = 1 - dayW - nightW;         if (duskW < 0) duskW = 0;
    var bR = SKY_DAY_Z[0]*dayW + SKY_DUSK_Z[0]*duskW + SKY_NIGHT_Z[0]*nightW;
    var bG = SKY_DAY_Z[1]*dayW + SKY_DUSK_Z[1]*duskW + SKY_NIGHT_Z[1]*nightW;
    var bB = SKY_DAY_Z[2]*dayW + SKY_DUSK_Z[2]*duskW + SKY_NIGHT_Z[2]*nightW;
    // 전체 배경 (원 밖 영역은 검정)
    ctx.fillStyle = 'rgba(0, 0, 0, 0.96)';
    ctx.fillRect(0, 0, SCR_W, SCR_H);
    // 원반 (하늘)
    ctx.fillStyle = 'rgb(' + (bR|0) + ',' + (bG|0) + ',' + (bB|0) + ')';
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.fill();

    // 태양 (altDeg > -2일 때)
    if (sun.altDeg > -2) {
        var sDlt = sun.azRad + camera.angle;
        var sR2 = (Math.PI / 2 - sun.altRad) / (Math.PI / 2) * R;
        var spx = cx + Math.sin(sDlt) * sR2;
        var spy = cy - Math.cos(sDlt) * sR2;
        var sunR, sunG, sunB;
        if (sun.altDeg > 15)      { sunR = 255; sunG = 245; sunB = 220; }
        else if (sun.altDeg > 0)  { sunR = 255; sunG = 190; sunB = 130; }
        else                       { sunR = 240; sunG = 130; sunB =  80; }
        // 후광
        var grad = ctx.createRadialGradient(spx, spy, 2, spx, spy, 24);
        grad.addColorStop(0, 'rgba(' + sunR + ',' + sunG + ',' + sunB + ',1)');
        grad.addColorStop(1, 'rgba(' + sunR + ',' + sunG + ',' + sunB + ',0)');
        ctx.fillStyle = grad;
        ctx.beginPath(); ctx.arc(spx, spy, 24, 0, Math.PI * 2); ctx.fill();
        // 디스크
        ctx.fillStyle = 'rgb(' + sunR + ',' + sunG + ',' + sunB + ')';
        ctx.beginPath(); ctx.arc(spx, spy, 5, 0, Math.PI * 2); ctx.fill();
    }

    // 별 (밤 구간에서만, 낮엔 가시성 0)
    if (sun.altDeg < 0) {
        var nightFade = (-sun.altDeg) / 6;
        if (nightFade > 1) nightFade = 1;
        for (var si = 0; si < STARS.length; si++) {
            var star = STARS[si];
            var st = starState[si];
            if (st.altRad < 0) continue;
            var dlt = st.azRad + camera.angle;
            var r = (Math.PI / 2 - st.altRad) / (Math.PI / 2) * R;
            var px = cx + Math.sin(dlt) * r;
            var py = cy - Math.cos(dlt) * r;
            var mag = star.mag, size, alpha;
            if (mag < 0)      { size = 3;   alpha = 1.0;  }
            else if (mag < 1) { size = 2.5; alpha = 0.95; }
            else if (mag < 2) { size = 2;   alpha = 0.85; }
            else if (mag < 3) { size = 1.5; alpha = 0.7;  }
            else              { size = 1;   alpha = 0.55; }
            alpha *= nightFade;
            ctx.fillStyle = 'rgba(250, 250, 255, ' + alpha + ')';
            ctx.beginPath(); ctx.arc(px, py, size, 0, Math.PI * 2); ctx.fill();
        }
    }

    // 행성 (태양이 지평선 아래일 때만 표시 — 낮엔 태양빛에 묻혀 안 보임)
    if (sun.altDeg < 0) {
        for (var pi = 0; pi < PLANETS.length; pi++) {
            var ps = planetState[pi];
            if (ps.altRad < 0) continue;
            if (ps.mag > 6) continue;  // 천왕성/해왕성 맨눈 한계 넘음
            var dltp = ps.azRad + camera.angle;
            var rp = (Math.PI / 2 - ps.altRad) / (Math.PI / 2) * R;
            var ppx = cx + Math.sin(dltp) * rp;
            var ppy = cy - Math.cos(dltp) * rp;
            var col = PLANETS[pi].color;
            var cR = col & 0xFF, cG = (col >> 8) & 0xFF, cB = (col >> 16) & 0xFF;
            var psize = ps.mag < -3 ? 3 : ps.mag < 0 ? 2.5 : ps.mag < 2 ? 2 : 1.5;
            ctx.fillStyle = 'rgba(' + cR + ',' + cG + ',' + cB + ',0.95)';
            ctx.beginPath(); ctx.arc(ppx, ppy, psize, 0, Math.PI * 2); ctx.fill();
        }
    }

    // 달 (태양 지평선 아래일 때만 — 낮엔 태양빛에 묻혀 안 보임)
    if (moonState.altRad > 0 && sun.altDeg < 0) {
        var dlm = moonState.azRad + camera.angle;
        var rm = (Math.PI / 2 - moonState.altRad) / (Math.PI / 2) * R;
        var mmx = cx + Math.sin(dlm) * rm;
        var mmy = cy - Math.cos(dlm) * rm;
        var MR2 = 7;
        var ill2 = moonState.illumination;
        var side2 = Math.sin(moonState.phase) >= 0 ? 1 : -1;
        ctx.save();
        ctx.beginPath();
        ctx.arc(mmx, mmy, MR2, 0, Math.PI * 2);
        ctx.clip();
        // 어두운 면: 낮엔 배경 그대로, 밤엔 어두운 회색 반투명
        if (sun.altDeg < 0) {
            ctx.fillStyle = 'rgba(60, 65, 80, 0.75)';
            ctx.fillRect(mmx - MR2, mmy - MR2, MR2 * 2, MR2 * 2);
        }
        ctx.fillStyle = 'rgb(240, 245, 250)';
        if (ill2 >= 0.97) {
            ctx.fillRect(mmx - MR2, mmy - MR2, MR2 * 2, MR2 * 2);
        } else if (ill2 > 0.03) {
            var t = side2 * (1 - 2 * ill2) * MR2;
            if (side2 > 0) ctx.fillRect(mmx + t, mmy - MR2, MR2 - t, MR2 * 2);
            else           ctx.fillRect(mmx - MR2, mmy - MR2, MR2 + t, MR2 * 2);
        }
        ctx.restore();
    }

    // 배 방향 화살표 (화면 위쪽 = 배가 향한 곳)
    ctx.fillStyle = 'rgba(255, 230, 180, 0.8)';
    ctx.font = 'bold 10px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('▲', cx, cy - R - 10);
    // 범례
    ctx.textAlign = 'left';
    ctx.font = '10px monospace';
    ctx.fillStyle = 'rgba(200, 220, 255, 0.7)';
    ctx.fillText('K: 닫기   (중심=천정, 위=배 방향, 시간정지)', 12, SCR_H - 12);
}

function DrawBoat() {
    // 파도 흔들림
    var wt = wave.time;
    var bob = Math.sin(boat.gx * wave.swell.dx + boat.gy * wave.swell.dy + wt * wave.swell.speed) * 1.5;

    // Flip: buf → canvas 후 이미지를 ctx 위에 직접 그리기
    imagedata.data.set(buf8);
    ctx.putImageData(imagedata, 0, 0);

    // 배 위치: 화면 중앙에서 아래쪽 (수평선 밑으로 선체가 내려오도록)
    // 2x 스케일 — 해상도 800x600에 맞춰 보트 시각 크기 유지
    var BOAT_Y_OFFSET = 78;
    var BOAT_SCALE = 0.89;
    var dw = boatImg.width * BOAT_SCALE, dh = boatImg.height * BOAT_SCALE;
    var sx = (SCR_W - dw) / 2 | 0;
    var sy = (SCR_H - dh) / 2 + BOAT_Y_OFFSET + bob | 0;
    ctx.drawImage(boatImg, 0, 0, boatImg.width, boatImg.height, sx, sy, dw, dh);
}

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
        'MMZoom:  1:' + minimapStride + '\n' +
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
