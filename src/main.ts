import {
    SCR_W, SCR_H, SEA,
    TILE_SIZE, TILE_SHIFT, WORLD_TILES_X, WORLD_TILES_Y, WORLD_W, WORLD_H,
    BUF_TILES, SHIFT, SIZE, MASK,
    ORIGIN_LON, ORIGIN_LAT, DEG_PER_PIXEL,
    TIME_SPEED_MIN, TIME_SPEED_MAX,
} from './config';
import { canvas, ctx, imagedata, buf8, buf32 } from './canvas';
import {
    boat, ship, camera, input,
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
var skyMapOn = false;  // K 키: 천구 전체 뷰 (polar azimuthal)
var MM_STRIDE_MIN = 0.25, MM_STRIDE_MAX = 2048;

// 배 이동 — 대상 셀과 주변 8방향(상하좌우+대각선) 모두 바다여야 진입 허용.
// 해안선에 붙어있는 바다 1픽셀(coastal 1-cell)도 진입 불가 → 육지와 최소 1칸 간격 유지.
function moveBoat(dx, dy) {
    var mvLen = Math.hypot(dx, dy);
    if (mvLen === 0) return;
    var SUBSTEPS = Math.max(1, Math.ceil(mvLen * 4));
    var sx = dx / SUBSTEPS, sy = dy / SUBSTEPS;
    for (var si = 0; si < SUBSTEPS; si++) {
        var nx = boat.gx + sx;
        var ny = boat.gy + sy;
        var cx = Math.floor(nx), cy = Math.floor(ny);
        var blocked = false;
        for (var oy = -1; oy <= 1 && !blocked; oy++) {
            for (var ox = -1; ox <= 1; ox++) {
                var off = (((cy + oy) & MASK) << SHIFT) + ((cx + ox) & MASK) | 0;
                if (altitude[off] > SEA) { blocked = true; break; }
            }
        }
        if (blocked) break;
        nx = ((nx % WORLD_W) + WORLD_W) % WORLD_W;
        if (ny < 0) ny = 0;
        else if (ny > WORLD_H - 1) ny = WORLD_H - 1;
        boat.gx = nx;
        boat.gy = ny;
    }
}

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
            skyMapOn = !skyMapOn;
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

// --- DrawVerticalLine (exact reference implementation) ---
function DrawVerticalLine(x, ytop, ybottom, col) {
    x = x | 0;
    ytop = ytop | 0;
    ybottom = ybottom | 0;
    col = col | 0;
    if (ytop < 0) ytop = 0;
    if (ytop > ybottom) return;
    var offset = ((ytop * SCR_W) + x) | 0;
    for (var k = ytop | 0; k < ybottom | 0; k = k + 1 | 0) {
        buf32[offset | 0] = col | 0;
        offset = offset + SCR_W | 0;
    }
}

// --- DrawBackground ---
// 수평: FOV 90° ⇒ 45° = 화면 절반(±320px).
// 수직: 고도 선형 매핑 (천정까지 등속).
//   alt=0°  ⇒ screenY = horizon
//   alt=90° ⇒ screenY = 0 (천정 = 화면 상단)
var PX_PER_RAD_H = SCR_W / (Math.PI / 2);

function DrawBackground() {
    updateSky(sun.altDeg, weather.cloudiness);
    updateCloudMask();
    // 구름 색 (낮=흰, 밤=어두운 회색, 황혼=주황 섞임) — updateSky cGray와 유사
    var cldDay   = sun.altDeg > 5 ? 1 : (sun.altDeg > -6 ? (sun.altDeg + 6) / 11 : 0);
    var cldNight = sun.altDeg < -6 ? 1 : 0;
    var cldDusk  = 1 - cldDay - cldNight; if (cldDusk < 0) cldDusk = 0;
    var cloudR = 240 * cldDay + 180 * cldDusk + 30 * cldNight;
    var cloudG = 240 * cldDay + 140 * cldDusk + 34 * cldNight;
    var cloudB = 245 * cldDay + 120 * cldDusk + 45 * cldNight;
    var horizonY = (camera && camera.horizon) ? camera.horizon : (SCR_H * 0.5) | 0;
    var cloudActive = weather.cloudiness > 0.15;
    for (var y = 0; y < SCR_H; y++) {
        var c = skyRow[y];
        var base = y * SCR_W;
        var gy = skyGlowY[y];
        var isSky = y < horizonY;
        var cFyRow = (isSky && cloudActive) ? (((horizonY - y) / horizonY * (CLOUD_FULL_H - 1)) | 0) : -1;
        if (cFyRow >= CLOUD_FULL_H) cFyRow = CLOUD_FULL_H - 1;
        var glowOn = gy > 0.001;
        if (!glowOn && cFyRow < 0) {
            // 순수 하늘색 — fill 빠른 경로
            buf32.fill(c, base, base + SCR_W);
            continue;
        }
        var bR0 = c & 0xFF, bG0 = (c >> 8) & 0xFF, bB0 = (c >> 16) & 0xFF;
        var cloudRow = cFyRow >= 0 ? cFyRow * SCR_W : -1;
        for (var x = 0; x < SCR_W; x++) {
            var pxc = c;
            if (glowOn) {
                var a = gy * skyGlowX[x];
                if (a > 0.005) {
                    if (a > 1) a = 1;
                    var nR = (bR0 + (skyGlow.r - bR0) * a) | 0;
                    var nG = (bG0 + (skyGlow.g - bG0) * a) | 0;
                    var nB = (bB0 + (skyGlow.b - bB0) * a) | 0;
                    pxc = 0xFF000000 | (nB << 16) | (nG << 8) | nR;
                }
            }
            if (cloudRow >= 0) {
                var ca = cloudFull[cloudRow + x];
                if (ca > 4) {
                    var caf = ca * (1 / 255);
                    var pR = pxc & 0xFF, pG = (pxc >> 8) & 0xFF, pB = (pxc >> 16) & 0xFF;
                    var mR = (pR + (cloudR - pR) * caf) | 0;
                    var mG = (pG + (cloudG - pG) * caf) | 0;
                    var mB = (pB + (cloudB - pB) * caf) | 0;
                    pxc = 0xFF000000 | (mB << 16) | (mG << 8) | mR;
                }
            }
            buf32[base + x] = pxc;
        }
    }

    // --- Milky Way band (별보다 뒤, 하늘 위) ---
    // 태양 -6° 이하 야간에서만. 구름에 많이 가려짐.
    if (sun.altDeg < -6) {
        var mwDark = (-sun.altDeg - 6) / 6;
        if (mwDark > 1) mwDark = 1;
        mwDark *= (1 - weather.cloudiness * 0.9);
        if (mwDark > 0.05) {
            for (var mj = 0; mj < MILKYWAY.length; mj++) {
                var mws = milkyState[mj];
                if (mws.altRad < 0) continue;
                var mdlt = mws.azRad + camera.angle;
                mdlt = ((mdlt + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
                if (Math.abs(mdlt) > Math.PI / 2) continue;
                var mxp = (SCR_W / 2 + mdlt * PX_PER_RAD_H) | 0;
                var myp = (camera.horizon - mws.altRad * (camera.horizon / (Math.PI / 2))) | 0;
                if (mxp < 0 || mxp >= SCR_W || myp < 0 || myp >= SCR_H) continue;
                // 구름 차폐
                var mCov = cloudAlphaAt(mxp, myp, horizonY);
                if (mCov > 0.5) continue;
                var mwa = mwDark * MILKYWAY[mj].dens * 0.35 * (1 - mCov);
                // 2x2 부드러운 번짐 — 띠로 보이도록
                for (var mdy = -1; mdy <= 1; mdy++) {
                    for (var mdx = -1; mdx <= 1; mdx++) {
                        var lxm2 = mxp + mdx, lym2 = myp + mdy;
                        if (lxm2 < 0 || lxm2 >= SCR_W || lym2 < 0 || lym2 >= SCR_H) continue;
                        var falloff = (mdx === 0 && mdy === 0) ? 1 : 0.4;
                        var aM = mwa * falloff;
                        if (aM < 0.005) continue;
                        var idxm = lym2 * SCR_W + lxm2;
                        var bgm = buf32[idxm];
                        var bRm = bgm & 0xFF, bGm = (bgm >> 8) & 0xFF, bBm = (bgm >> 16) & 0xFF;
                        var nRm = (bRm + (200 - bRm) * aM) | 0;
                        var nGm = (bGm + (210 - bGm) * aM) | 0;
                        var nBm = (bBm + (235 - bBm) * aM) | 0;
                        buf32[idxm] = 0xFF000000 | (nBm << 16) | (nGm << 8) | nRm;
                    }
                }
            }
        }
    }

    // --- Stars + 별자리 선 ---
    // 태양 고도 0° → 별 숨김, -12° 이하 → 완전한 밤. 구름에 가려짐 반영.
    if (sun.altDeg < 0) {
        var darkness = (-sun.altDeg) / 12;
        if (darkness > 1) darkness = 1;
        darkness *= (1 - weather.cloudiness * 0.8);

        // Twinkle 시간 기반: 벽시계초(실시간) — 시간가속 무관 자연스러운 깜박임
        var twT = (typeof performance !== 'undefined' ? performance.now() : Date.now()) * 0.001;
        for (var si = 0; si < STARS.length; si++) {
            var star = STARS[si];
            var st = starState[si];
            if (st.altRad < 0) continue;  // 지평선 아래
            var dlt = st.azRad + camera.angle;
            dlt = ((dlt + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
            if (Math.abs(dlt) > Math.PI / 2) continue;
            var sxs = (SCR_W / 2 + dlt * PX_PER_RAD_H) | 0;
            var sys = (camera.horizon - st.altRad * (camera.horizon / (Math.PI / 2))) | 0;
            if (sxs < 0 || sxs >= SCR_W || sys < 0 || sys >= SCR_H) continue;
            // 구름 차폐 — 두꺼운 구름 위에서는 숨김
            var sCov = cloudAlphaAt(sxs, sys, horizonY);
            if (sCov > 0.55) continue;
            // 밝기 — magnitude 낮을수록 밝음. mag 4 근처도 희미하게 보이도록 floor 0.3.
            var magBright = (4.0 - star.mag) / 3.5;
            if (magBright < 0.3) magBright = 0.3;
            else if (magBright > 1.2) magBright = 1.2;
            // Twinkle — 고도 낮을수록 진폭↑ (대기 굴절 근사)
            var altDegSt = st.altRad * 57.2958;
            var twAmp = 0.18 + (altDegSt < 15 ? (15 - altDegSt) / 15 * 0.35 : 0);
            if (twAmp > 0.5) twAmp = 0.5;
            var twMod = 1 + twAmp * Math.sin(twT * starTwinkleFreq[si] + starTwinklePhase[si]);
            var alpha = darkness * magBright * twMod;
            var blendPx = function (lx, ly, a) {
                if (lx < 0 || lx >= SCR_W || ly < 0 || ly >= SCR_H) return;
                if (a > 1) a = 1;
                var idx = ly * SCR_W + lx;
                var bg = buf32[idx];
                var bR = bg & 0xFF, bG = (bg >> 8) & 0xFF, bB = (bg >> 16) & 0xFF;
                var nR = (bR + (255 - bR) * a) | 0;
                var nG = (bG + (255 - bG) * a) | 0;
                var nB = (bB + (250 - bB) * a) | 0;
                buf32[idx] = 0xFF000000 | (nB << 16) | (nG << 8) | nR;
            };
            // 중심: 밤일 때 순백 직접 덮어쓰기로 확실한 가시성
            if (alpha > 0.5 && sxs >= 0 && sxs < SCR_W && sys >= 0 && sys < SCR_H) {
                buf32[sys * SCR_W + sxs] = 0xFFFAFAFF;
            } else {
                blendPx(sxs, sys, alpha);
            }
            // 2x2 주변 보조
            blendPx(sxs + 1, sys,     alpha * 0.75);
            blendPx(sxs,     sys + 1, alpha * 0.75);
            blendPx(sxs + 1, sys + 1, alpha * 0.55);
            // 밝은 별 (mag < 1) — 크로스 확장
            if (star.mag < 1.0) {
                blendPx(sxs - 1, sys,     alpha * 0.6);
                blendPx(sxs + 2, sys,     alpha * 0.5);
                blendPx(sxs,     sys - 1, alpha * 0.6);
                blendPx(sxs,     sys + 2, alpha * 0.5);
            }
            // 매우 밝은 별 (mag < 0) — 코너
            if (star.mag < 0.0) {
                blendPx(sxs - 1, sys - 1, alpha * 0.4);
                blendPx(sxs + 2, sys + 2, alpha * 0.4);
                blendPx(sxs + 2, sys - 1, alpha * 0.4);
                blendPx(sxs - 1, sys + 2, alpha * 0.4);
            }
        }
    }

    // --- Planets (태양 지평선 아래일 때만. 낮엔 태양 빛으로 안 보임) ---
    if (sun.altDeg < 0) {
        var pFade = (-sun.altDeg) / 6;
        if (pFade > 1) pFade = 1;
        pFade *= (1 - weather.cloudiness * 0.8);
        for (var pi = 0; pi < PLANETS.length; pi++) {
            var ps = planetState[pi];
            if (ps.altRad < 0) continue;
            var dltp = ps.azRad + camera.angle;
            dltp = ((dltp + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
            if (Math.abs(dltp) > Math.PI / 2) continue;
            var ppx = (SCR_W / 2 + dltp * PX_PER_RAD_H) | 0;
            var ppy = (camera.horizon - ps.altRad * (camera.horizon / (Math.PI / 2))) | 0;
            if (ppx < 1 || ppx >= SCR_W - 1 || ppy < 1 || ppy >= SCR_H - 1) continue;
            var pmag = ps.mag;
            // 맨눈 한계 ~6. 천왕성(5.7)/해왕성(7.8)은 거의 안 보임. 보여도 작게.
            if (pmag > 6) continue;
            var pCov = cloudAlphaAt(ppx, ppy, camera.horizon);
            if (pCov > 0.55) continue;
            var c = PLANETS[pi].color;
            // 밝은 행성(금성·목성)은 십자 + 중심
            if (pmag < -1) {
                buf32[ppy * SCR_W + ppx] = c;
                buf32[ppy * SCR_W + (ppx - 1)] = c;
                buf32[ppy * SCR_W + (ppx + 1)] = c;
                buf32[(ppy - 1) * SCR_W + ppx] = c;
                buf32[(ppy + 1) * SCR_W + ppx] = c;
                buf32[(ppy - 1) * SCR_W + (ppx - 1)] = c;
                buf32[(ppy + 1) * SCR_W + (ppx + 1)] = c;
            } else {
                buf32[ppy * SCR_W + ppx] = c;
                buf32[ppy * SCR_W + (ppx + 1)] = c;
                buf32[(ppy + 1) * SCR_W + ppx] = c;
            }
        }
    }

    // --- Moon (태양 지평선 아래일 때만 — 낮엔 태양빛에 묻혀 안 보임) ---
    if (moonState.altRad > 0 && sun.altDeg < 0) {
        var dlm = moonState.azRad + camera.angle;
        dlm = ((dlm + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
        if (Math.abs(dlm) < Math.PI / 2) {
            var mx = (SCR_W / 2 + dlm * PX_PER_RAD_H) | 0;
            var my = (camera.horizon - moonState.altRad * (camera.horizon / (Math.PI / 2))) | 0;
            var moonCov = cloudAlphaAt(mx, my, camera.horizon);
            var MR = 5;
            var ill = moonState.illumination;
            var side = Math.sin(moonState.phase) >= 0 ? 1 : -1;
            var bright = 0xFFE8F0F4;  // 밝은 면
            var isDay = sun.altDeg > 0;
            if (moonCov > 0.8) { /* 두꺼운 구름 뒤 — 생략 */ } else {
            // --- Moon halo (cloudiness > 0.3 일 때 습한 대기 산란 느낌) ---
            if (weather.cloudiness > 0.3 && ill > 0.1) {
                var MHR = 16 + (weather.cloudiness * 10) | 0;  // 16~26
                var MHR2 = MHR * MHR;
                var haloStrength = (weather.cloudiness - 0.3) * 0.7 * ill;  // 0~0.49
                for (var dhy = -MHR; dhy <= MHR; dhy++) {
                    var lhy = my + dhy;
                    if (lhy < 0 || lhy >= SCR_H) continue;
                    for (var dhx = -MHR; dhx <= MHR; dhx++) {
                        var d2h = dhx * dhx + dhy * dhy;
                        if (d2h > MHR2 || d2h <= MR * MR) continue;
                        var lhx = mx + dhx;
                        if (lhx < 0 || lhx >= SCR_W) continue;
                        var dh = Math.sqrt(d2h);
                        var th = (dh - MR) / (MHR - MR);
                        var ah = (1 - th) * (1 - th) * haloStrength;
                        var idxh = lhy * SCR_W + lhx;
                        var bgh = buf32[idxh];
                        var bRh = bgh & 0xFF, bGh = (bgh >> 8) & 0xFF, bBh = (bgh >> 16) & 0xFF;
                        var nRh = (bRh + (220 - bRh) * ah) | 0;
                        var nGh = (bGh + (225 - bGh) * ah) | 0;
                        var nBh = (bBh + (235 - bBh) * ah) | 0;
                        buf32[idxh] = 0xFF000000 | (nBh << 16) | (nGh << 8) | nRh;
                    }
                }
            }
            for (var dym = -MR; dym <= MR; dym++) {
                for (var dxm = -MR; dxm <= MR; dxm++) {
                    if (dxm * dxm + dym * dym > MR * MR) continue;
                    var lxm = mx + dxm, lym = my + dym;
                    if (lxm < 0 || lxm >= SCR_W || lym < 0 || lym >= SCR_H) continue;
                    var normX = dxm / MR;
                    var termX = side * (1 - 2 * ill);
                    var lit;
                    if (ill >= 0.97) lit = true;
                    else if (ill <= 0.03) lit = false;
                    else lit = (side > 0 ? normX > termX : normX < termX);
                    if (lit) {
                        buf32[lym * SCR_W + lxm] = bright;
                    } else if (!isDay) {
                        // 밤: 어두운 면에 earthshine 느낌 약한 회색 블렌드
                        var idx = lym * SCR_W + lxm;
                        var bg = buf32[idx];
                        var bR = bg & 0xFF, bG = (bg >> 8) & 0xFF, bB = (bg >> 16) & 0xFF;
                        var a = 0.4;
                        var nR = (bR + (64 - bR) * a) | 0;
                        var nG = (bG + (72 - bG) * a) | 0;
                        var nB = (bB + (84 - bB) * a) | 0;
                        buf32[idx] = 0xFF000000 | (nB << 16) | (nG << 8) | nR;
                    }
                    // 낮: 어두운 면은 배경 유지 (하늘과 자연스럽게 섞임)
                }
            }
            }  // end if (moonCov > 0.8)
        }
    }

    // --- Sun disk ---
    // 카메라 heading(표준 0=북, 시계) = -camera.angle
    // delta = sunAz - cam_heading = sunAz + camera.angle   (표준 방위계에서)
    var delta = sun.azRad + camera.angle;
    delta = ((delta + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
    if (sun.altDeg > -2 && Math.abs(delta) < Math.PI / 2) {
        var sxC = (SCR_W / 2 + delta * PX_PER_RAD_H) | 0;
        var syC = (camera.horizon - sun.altRad * (camera.horizon / (Math.PI / 2))) | 0;
        // 태양색 (고도 기준): 높으면 연노랑/흰, 낮으면 주황
        var sR, sG, sB;
        if (sun.altDeg > 15) {
            sR = 255; sG = 245; sB = 220;
        } else if (sun.altDeg > 0) {
            var tt = sun.altDeg / 15;
            sR = 255;
            sG = 150 + (95 * tt) | 0;
            sB =  90 + (130 * tt) | 0;
        } else {
            sR = 240; sG = 120; sB = 70;
        }
        var sunColor = 0xFF000000 | (sB << 16) | (sG << 8) | sR;
        var R = 6, R2 = R * R;
        // Halo 프로파일: 고도 낮을수록 반경↑ + 붉은기↑. cloudiness↑면 산란 더 많음.
        //   alt≥30°: HR=140 (맑고 집중)
        //   alt 0~30°: 140→300 선형
        //   alt<0°: 300+ (해진 직후 최대 잔광)
        var haloBase;
        if (sun.altDeg >= 30) haloBase = 140;
        else if (sun.altDeg >= 0) haloBase = 140 + (30 - sun.altDeg) * (160 / 30);
        else haloBase = 300 + (-sun.altDeg) * 10;
        if (haloBase > 380) haloBase = 380;
        var HR = (haloBase * (1 + weather.cloudiness * 0.25)) | 0;
        var HR2 = HR * HR;
        // Halo 색: 저고도일수록 붉게 편이. 디스크색과 별개로 지정.
        var altT = sun.altDeg / 30;
        if (altT < 0) altT = 0; else if (altT > 1) altT = 1;
        var hR_ = (255) | 0;
        var hG_ = (100 + 140 * altT) | 0;
        var hB_ = ( 70 + 140 * altT) | 0;
        // 바깥 halo → 안쪽 디스크 순 (halo 그린 후 디스크로 덮어쓰기)
        for (var dy = -HR; dy <= HR; dy++) {
            var ly = syC + dy;
            if (ly < 0 || ly >= SCR_H) continue;
            for (var dxs = -HR; dxs <= HR; dxs++) {
                var d2 = dxs * dxs + dy * dy;
                if (d2 > HR2) continue;
                var lx = sxC + dxs;
                if (lx < 0 || lx >= SCR_W) continue;
                var idx = ly * SCR_W + lx;
                if (d2 <= R2) {
                    buf32[idx] = sunColor;
                } else {
                    // 후광: R → HR 구간 알파 quadratic falloff, halo 색(hR_/hG_/hB_)로 블렌드
                    var d = Math.sqrt(d2);
                    var t = (d - R) / (HR - R);
                    var a = (1 - t) * (1 - t);
                    var bg = buf32[idx];
                    var bR = bg & 0xFF, bG = (bg >> 8) & 0xFF, bB = (bg >> 16) & 0xFF;
                    var nR = (bR + (hR_ - bR) * a) | 0;
                    var nG = (bG + (hG_ - bG) * a) | 0;
                    var nB = (bB + (hB_ - bB) * a) | 0;
                    buf32[idx] = 0xFF000000 | (nB << 16) | (nG << 8) | nR;
                }
            }
        }
    }
}

// --- Render (exact reference algorithm + fog) ---
// hiddeny: 함수 밖에 한 번만 할당 → GC 부담 제거
var hiddeny = new Int32Array(SCR_W);

function Render() {
    var sinang = Math.sin(camera.angle);
    var cosang = Math.cos(camera.angle);

    // Render가 수평선 위/아래 전부 담당. 육지 샘플이 수평선 아래로 투영되면
    // 물에 가려 안 보이는 게 맞으므로 skip → 더 먼 z의 바다 샘플이 채우게 함
    hiddeny.fill(SCR_H);
    var openCount = SCR_W;   // 아직 '닫히지 않은' (hiddeny > 0) 컬럼 수

    // deltaz: 작을수록 far z에서 1도 회전 시 sample shift가 줄어 angle aliasing 감소.
    // 근거리는 세밀하게, 멀리는 완만하게 증가.
    var deltaz = 0.5;
    var camMeters = camera.heightMeters;

    // 지구 곡률: 거리 z에서 지표면이 flat-earth 대비 z²/(2R) 만큼 낮아짐.
    // tile_index.json: pixel_deg=0.004167 (15 arc-sec/px) → 한국 위도에서
    //   Y(위도): 111km/240 ≈ 463m/px, X(경도): 111km·cos(33°)/240 ≈ 387m/px
    //   평균 ~400m/unit로 근사.
    //   drop_m(z) = (z * UNIT_M)² / (2R) = z² * (UNIT_M² / 2R)
    var UNIT_M = 400;
    var CURVATURE_COEFF = (UNIT_M * UNIT_M) / (2 * 6371000);
    var HEIGHT_SEA = heightMeters[SEA];  // allSea fast path용 상수

    // 파도 단계 임계값 (거리별 sin 개수 감소)
    var dist = camera.distance;
    var dist_wave_3 = dist * 0.2;   // 3 sin (swell+mid+ripple)
    var dist_wave_2 = dist * 0.5;   // 2 sin (swell+mid)
    var dist_wave_1 = dist * 0.7;   // 1 sin (swell)

    // 파도 파벡터/상수 캐싱 (내부 루프에서 반복 접근 최소화)
    var wt  = wave.time;
    var wsdx = wave.swell.dx,  wsdy = wave.swell.dy,  wss = wave.swell.speed,  wsa = wave.swell.amp;
    var wmdx = wave.mid.dx,    wmdy = wave.mid.dy,    wms = wave.mid.speed,    wma = wave.mid.amp;
    var wrdx = wave.ripple.dx, wrdy = wave.ripple.dy, wrs = wave.ripple.speed, wra = wave.ripple.amp;

    var visDist = dist * weather.visibilityCoef;
    var horizon = camera.horizon;
    var camX = camera.x, camY = camera.y;

    for (var z = 1; z < dist; z += deltaz) {
        // 이 z에서의 곡률 drop (meters) — 같은 z에선 column 무관
        var curvatureDrop = z * z * CURVATURE_COEFF;
        // 90 degree field of view
        var plx =  -cosang * z - sinang * z;
        var ply =   sinang * z - cosang * z;
        var prx =   cosang * z - sinang * z;
        var pry =  -sinang * z - cosang * z;

        var dx = (prx - plx) / SCR_W;
        var dy = (pry - ply) / SCR_W;
        plx += camX;
        ply += camY;
        // 미터 기반 투영. scale 0.44=1:1, 0.8≈1.8x 과장
        // projScale은 화면 세로 픽셀 수에 비례 (기준: 300px → 1.32)
        var projScale = (SCR_H * 0.0044) / z;

        // Fog: 사진처럼 먼 곳일수록 짙은 대기 안개. weather로 시정 단축.
        var fog = Math.pow(z / visDist, 1.2);
        if (fog > 1) fog = 1;
        var mf = 1.0 - fog;

        // 이 z에서 바다면 몇 개의 sin을 쓸지 (0=스킵)
        var waveStage = z < dist_wave_3 ? 3 : z < dist_wave_2 ? 2 : z < dist_wave_1 ? 1 : 0;

        // allSea용 지형 고도 · 화면 y (column 무관)
        var seaTerM = HEIGHT_SEA - curvatureDrop;
        var seaHos  = (camMeters - seaTerM) * projScale + horizon | 0;

        for (var i = 0; i < SCR_W | 0; i = i + 1 | 0) {
            // Tier 1-①: 이 컬럼이 이미 화면 상단까지 덮였으면 즉시 스킵
            var prevH = hiddeny[i];
            if (prevH <= 0) {
                plx += dx;
                ply += dy;
                continue;
            }

            // --- 4 이웃 인덱스 ---
            // plx, ply 는 camera.x/y (항상 양수 수만대) 가 더해진 상태라 |0 = floor와 동일
            var px_i = plx | 0, py_i = ply | 0;
            var ix0 = px_i & MASK, iy0 = py_i & MASK;
            var ix1 = (ix0 + 1) & MASK, iy1 = (iy0 + 1) & MASK;
            var off00 = (iy0 << SHIFT) + ix0 | 0;

            var a00 = altitude[off00];

            var heightonscreen, cR, cG, cB, isSea;

            // 4 이웃 바다 여부 한 번에 체크
            var off10 = (iy0 << SHIFT) + ix1 | 0;
            var off01 = (iy1 << SHIFT) + ix0 | 0;
            var off11 = (iy1 << SHIFT) + ix1 | 0;
            var a10 = altitude[off10], a01 = altitude[off01], a11 = altitude[off11];
            var allSea = (a00 <= SEA) & (a10 <= SEA) & (a01 <= SEA) & (a11 <= SEA);
            isSea = allSea !== 0;

            if (isSea) {
                // Tier 1-②: allSea fast path — bilinear 전부 스킵, 상수 사용
                heightonscreen = seaHos;
                if (heightonscreen >= prevH) {
                    plx += dx;
                    ply += dy;
                    continue;
                }
                var cc = colormap[off00];
                cR = cc & 0xFF;
                cG = (cc >> 8) & 0xFF;
                cB = (cc >> 16) & 0xFF;
            } else {
                var fpx = plx - px_i, fpy = ply - py_i;
                var w00 = (1 - fpx) * (1 - fpy);
                var w10 = fpx * (1 - fpy);
                var w01 = (1 - fpx) * fpy;
                var w11 = fpx * fpy;

                // 높이(meters) bilinear — occlusion 판정에 필요하므로 선행
                var terMeters = heightMeters[a00] * w00 + heightMeters[a10] * w10
                              + heightMeters[a01] * w01 + heightMeters[a11] * w11;
                terMeters -= curvatureDrop;
                heightonscreen = (camMeters - terMeters) * projScale + horizon | 0;
                if (heightonscreen >= prevH) {
                    plx += dx;
                    ply += dy;
                    continue;
                }

                // --- 드로우 확정: 색상 bilinear ---
                var c00 = colormap[off00], c10v = colormap[off10];
                var c01v = colormap[off01], c11v = colormap[off11];
                cR = (c00 & 0xFF) * w00 + (c10v & 0xFF) * w10
                   + (c01v & 0xFF) * w01 + (c11v & 0xFF) * w11;
                cG = ((c00 >> 8) & 0xFF) * w00 + ((c10v >> 8) & 0xFF) * w10
                   + ((c01v >> 8) & 0xFF) * w01 + ((c11v >> 8) & 0xFF) * w11;
                cB = ((c00 >> 16) & 0xFF) * w00 + ((c10v >> 16) & 0xFF) * w10
                   + ((c01v >> 16) & 0xFF) * w01 + ((c11v >> 16) & 0xFF) * w11;
            }

            // Tier 2-①: 파도 색상 변조 — 거리별로 sin 개수 단계 축소.
            // 카메라 상대 좌표로 계산 — 파벡터가 프레임 간 조금 바뀌어도
            // 큰 월드 좌표(수만)에 곱해져 전체 위상이 튀는 '깜박임' 방지.
            if (isSea && waveStage > 0) {
                var wx = plx - camX, wy = ply - camY;
                var waveVal = Math.sin(wx * wsdx + wy * wsdy + wt * wss) * wsa;
                if (waveStage >= 2) waveVal += Math.sin(wx * wmdx + wy * wmdy + wt * wms) * wma;
                if (waveStage >= 3) waveVal += Math.sin(wx * wrdx + wy * wrdy + wt * wrs) * wra;
                var wc = waveVal * 7;
                cR += wc; cG += wc; cB += wc * 0.5;
            }

            var c = 0xFF000000
                  | ((cB < 0 ? 0 : cB > 255 ? 255 : cB | 0) << 16)
                  | ((cG < 0 ? 0 : cG > 255 ? 255 : cG | 0) << 8)
                  |  (cR < 0 ? 0 : cR > 255 ? 255 : cR | 0);

            // Apply fog: 육지는 어두운 실루엣, 바다는 하늘색으로
            if (fog > 0.05) {
                var fR = isSea ? FOG_SEA_R : FOG_LAND_R;
                var fG = isSea ? FOG_SEA_G : FOG_LAND_G;
                var fB = isSea ? FOG_SEA_B : FOG_LAND_B;
                var cr = (c & 0xFF) * mf + fR * fog | 0;
                var cg = ((c >> 8) & 0xFF) * mf + fG * fog | 0;
                var cb = ((c >> 16) & 0xFF) * mf + fB * fog | 0;
                c = 0xFF000000 | (cb << 16) | (cg << 8) | cr;
            }

            DrawVerticalLine(i, heightonscreen, prevH, c);
            hiddeny[i] = heightonscreen;
            // Tier 1-③: 이 컬럼이 막 '닫혔다' (처음으로 ≤ 0) 면 openCount 감소
            if (heightonscreen <= 0 && prevH > 0) openCount--;

            plx += dx;
            ply += dy;
        }
        deltaz += 0.005;

        // Tier 1-③: 모든 컬럼이 닫혔으면 z 루프 조기 종료
        if (openCount <= 0) break;
    }
}

// --- UpdateCamera (배 조종 → 카메라 추적) ---
function UpdateCamera() {
    var nowMs = new Date().getTime();
    var dtMs = nowMs - frameStats.lastMoveTime;

    // 게임 시간 누적 (TIME_SPEED 배속). 하늘보기 중엔 정지.
    if (!skyMapOn) timeRef.gameTime += dtMs * timeRef.TIME_SPEED;

    // 이동은 이산 입력 이벤트에서 moveBoat()로 처리 (연속 이동 없음)
    // 시선 고정 — 화면 상단(row 0) = alt 90° (천정), horizon = SCR_H/2 = 180

    // 카메라 = 배 위치에 즉시 snap. smoothing 제거 → 이동/회전 시
    // 뷰가 배에 정확히 고정되어 "보이는 배 기준" 조종감 유지.
    camera.x = boat.gx;
    camera.y = boat.gy;
    camera.angle = boat.angle;

    // 태양·바람·돛 효율·해류 갱신 (위/경도 + 게임 시각 기반)
    computeSun();
    computeWind();
    computeSail();
    computeCurrent();
    updateShipSpeed();
    computeWaves();
    updateStars();
    computeWeather();

    // 배 이동: 돛 추진 + 해류 drift를 각각 적용 (moveBoat로 해안 충돌 보존)
    //   UNIT_M = 400 m/unit → units = m/s × gameSeconds / 400
    var gameDt = skyMapOn ? 0 : (dtMs * timeRef.TIME_SPEED) / 1000;
    if (gameDt > 0) {
        if (boat.sailUp && ship.sailMS > 0.01) {
            var sU = ship.sailMS * gameDt / 400;
            moveBoat(-Math.sin(boat.angle) * sU, -Math.cos(boat.angle) * sU);
        }
        if (current.speedMS > 0.01) {
            var cU = current.speedMS * gameDt / 400;
            moveBoat(
                 Math.sin(current.angleRad) * cU,
                -Math.cos(current.angleRad) * cU
            );
        }
    }

    // 카메라 아래 지형이 있으면 그 위로 띄우기 (지형 내부 방지)
    var camoff = ((Math.floor(camera.y) & MASK) << SHIFT) + (Math.floor(camera.x) & MASK) | 0;
    var terAtCamM = heightMeters[altitude[camoff]];
    camera.heightMeters = Math.max(BASE_CAM_METERS, terAtCamM + CAM_HEIGHT_MARGIN);

    // 타일 관리: 보트 주변 3x3 로드 보장
    ensureTilesLoaded();

    frameStats.lastMoveTime = nowMs;
}

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
    if (!skyMapOn) return;
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
