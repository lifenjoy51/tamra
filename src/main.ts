(async function () {
// --- Config ---
var SCR_W = 640, SCR_H = 360;  // 16:9 internal
// 뷰포트에 정수배로 맞추는 PX_SCALE (crisp pixel 유지)
var PX_SCALE = Math.max(1, Math.min(
    Math.floor(window.innerWidth  / SCR_W),
    Math.floor(window.innerHeight / SCR_H)
));
var SEA = 64;             // 해수면 (0m = 출력값 64)

// 타일 시스템
var TILE_SIZE = 512;
var TILE_SHIFT = 9;                     // 2^9 = 512
var WORLD_TILES_X = 169;                // tile_index.json grid.cols
var WORLD_TILES_Y = 85;
var WORLD_W = WORLD_TILES_X * TILE_SIZE; // 86528
var WORLD_H = WORLD_TILES_Y * TILE_SIZE;

// 8x8 슬롯 버퍼 (4096x4096). 각 타일 (tx, ty) → 슬롯 (tx%8, ty%8)
// 5x5 로드 범위(2.5 타일 = 1280)가 렌더 거리(800)보다 커야 뒤쪽 오래된 타일이 안 보임
var BUF_TILES = 8;
var SHIFT = 12;                         // 2^12 = 4096
var SIZE  = 1 << SHIFT;
var MASK  = SIZE - 1;

// Geo 메타 (tile_index.json 일치) — 월드 픽셀 → 위/경도 변환용
var ORIGIN_LON = -180;
var ORIGIN_LAT = 90;
var DEG_PER_PIXEL = 2.1333333333333333 / 512;  // deg_per_tile / tile_size

// 시간 가속: 1초 실시간 = 120초 게임시간 ⇒ 하루 = 12분. T/Y 키로 조절
var TIME_SPEED = 120;
var TIME_SPEED_MIN = 1, TIME_SPEED_MAX = 7200;

// --- Canvas ---
var canvas = document.getElementById('c');
var ctx = canvas.getContext('2d');
canvas.width = SCR_W;
canvas.height = SCR_H;
function fitCanvas() {
    var s = Math.max(1, Math.min(
        Math.floor(window.innerWidth  / SCR_W),
        Math.floor(window.innerHeight / SCR_H)
    ));
    PX_SCALE = s;
    canvas.style.width  = SCR_W * s + 'px';
    canvas.style.height = SCR_H * s + 'px';
}
fitCanvas();
window.addEventListener('resize', fitCanvas);

// --- Double buffer (same pattern as s-macke/VoxelSpace) ---
var imagedata = ctx.createImageData(SCR_W, SCR_H);
var bufarray  = new ArrayBuffer(SCR_W * SCR_H * 4);
var buf8      = new Uint8Array(bufarray);
var buf32     = new Uint32Array(bufarray);

// Fog target: 바다 → 하늘색, 육지 → 어두운 회색 (실제 대기 원근감)
var FOG_SEA_R = 160, FOG_SEA_G = 185, FOG_SEA_B = 210;
var FOG_LAND_R = 90,  FOG_LAND_G = 100, FOG_LAND_B = 120;

// Sky palette — zenith(천정) / horizon(지평) RGB, 낮/황혼/밤 3단
var SKY_DAY_Z   = [ 60,  90, 170], SKY_DAY_H   = [160, 185, 210];
var SKY_DUSK_Z  = [ 42,  24,  64], SKY_DUSK_H  = [255, 144,  80];
var SKY_NIGHT_Z = [  6,   8,  28], SKY_NIGHT_H = [ 12,  16,  40];
var skyRow = new Uint32Array(SCR_H);
// 대기광: skyGlowX[x]·skyGlowY[y] 외적으로 태양 방위·지평근처 붉은기 분포 표현.
// 분리 가능(separable) 가정 — 정확한 물리 아닌 체감 근사. 값 0~255 범위 가산 강도.
var skyGlowX = new Float32Array(SCR_W);
var skyGlowY = new Float32Array(SCR_H);
var skyGlowR = 0, skyGlowG = 0, skyGlowB = 0;  // 띠 색 (황혼 붉은/주황)

// 태양 고도(deg)에 따라 skyRow 재계산. cloudiness로 회색 blend.
function updateSky(altDeg, cloudiness) {
    if (cloudiness === undefined) cloudiness = 0;
    var dayW   = (altDeg - 5) / 10;     if (dayW < 0) dayW = 0;   else if (dayW > 1) dayW = 1;
    var nightW = (-6 - altDeg) / 6;     if (nightW < 0) nightW = 0; else if (nightW > 1) nightW = 1;
    var duskW  = 1 - dayW - nightW;     if (duskW < 0) duskW = 0;
    var zR = SKY_DAY_Z[0]*dayW + SKY_DUSK_Z[0]*duskW + SKY_NIGHT_Z[0]*nightW;
    var zG = SKY_DAY_Z[1]*dayW + SKY_DUSK_Z[1]*duskW + SKY_NIGHT_Z[1]*nightW;
    var zB = SKY_DAY_Z[2]*dayW + SKY_DUSK_Z[2]*duskW + SKY_NIGHT_Z[2]*nightW;
    var hR = SKY_DAY_H[0]*dayW + SKY_DUSK_H[0]*duskW + SKY_NIGHT_H[0]*nightW;
    var hG = SKY_DAY_H[1]*dayW + SKY_DUSK_H[1]*duskW + SKY_NIGHT_H[1]*nightW;
    var hB = SKY_DAY_H[2]*dayW + SKY_DUSK_H[2]*duskW + SKY_NIGHT_H[2]*nightW;
    // 구름 blend: 낮엔 밝은 회색(200,205,210), 밤엔 어두운 회색(40,45,55), 황혼엔 주황 섞인 회색
    var cGray = 40 + 160 * dayW + 80 * duskW;
    var cGrayG = 45 + 160 * dayW + 70 * duskW;
    var cGrayB = 55 + 155 * dayW + 60 * duskW;
    var cdZ = cloudiness * 0.55;  // 천정 강도
    var cdH = cloudiness * 0.35;  // 지평 강도 (작음 — fog에 이미 잡힘)
    zR = zR * (1 - cdZ) + cGray * cdZ;
    zG = zG * (1 - cdZ) + cGrayG * cdZ;
    zB = zB * (1 - cdZ) + cGrayB * cdZ;
    hR = hR * (1 - cdH) + cGray * cdH;
    hG = hG * (1 - cdH) + cGrayG * cdH;
    hB = hB * (1 - cdH) + cGrayB * cdH;
    for (var sy = 0; sy < SCR_H; sy++) {
        var t = sy / SCR_H;
        var r = zR + (hR - zR) * t | 0;
        var g = zG + (hG - zG) * t | 0;
        var b = zB + (hB - zB) * t | 0;
        skyRow[sy] = 0xFF000000 | (b << 16) | (g << 8) | r;
    }

    // --- 지평 대기광 띠 (separable) ---
    // 태양이 지평선 근처(-6~+10°)일 때만 강하게 — 황혼기 비대칭 붉은 기
    // 방향 단서: 해가 뜬/진 방위를 색으로 판독 가능
    var glowStrength = 0;
    if (altDeg < 15 && altDeg > -8) {
        var k = 1 - Math.abs(altDeg - 3) / 12;   // peak near altDeg=3°
        if (k < 0) k = 0; else if (k > 1) k = 1;
        glowStrength = k * (1 - cloudiness * 0.5);
    }
    // 색: 저고도일수록 붉게, 고도↑면 주황/노랑
    var glowMix = (altDeg + 8) / 23;  // 0(지평 아래)~1(alt=15)
    if (glowMix < 0) glowMix = 0; else if (glowMix > 1) glowMix = 1;
    skyGlowR = 255;
    skyGlowG = (90 + 120 * glowMix) | 0;
    skyGlowB = ( 50 +  90 * glowMix) | 0;

    // skyGlowY: 지평(horizon) 근처 y에서 최대, 천정으로 갈수록 0
    var horizonY = (camera && camera.horizon) ? camera.horizon : (SCR_H * 0.5) | 0;
    for (var gy = 0; gy < SCR_H; gy++) {
        var dyH = gy - horizonY;
        // 지평 위쪽(dyH<0) 60px 내에서 fade, 아래쪽은 거의 0 (바다/지형이 덮음)
        var w;
        if (dyH <= 0) {
            var t2 = -dyH / 60;
            w = t2 < 1 ? (1 - t2) : 0;
        } else {
            w = 0;
        }
        skyGlowY[gy] = w * glowStrength;
    }

    // skyGlowX: 태양 방위 기준 cos falloff. 태양 반대편엔 0.
    // sun.azRad + camera.angle = delta (화면 중앙 기준 방위 차)
    var sunDelta = 0;
    if (window.sun && window.camera) {
        var d = sun.azRad + camera.angle;
        sunDelta = ((d + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
    }
    for (var gx = 0; gx < SCR_W; gx++) {
        // 화면 좌표 → 방위각(카메라 상대)
        var relAz = (gx - SCR_W / 2) / PX_PER_RAD_H_INIT;
        var ang = relAz - sunDelta;
        // cos(ang) falloff, 음수는 0으로 클램프
        var ca = Math.cos(ang);
        skyGlowX[gx] = ca > 0 ? ca * ca : 0;
    }
}
var PX_PER_RAD_H_INIT = SCR_W / (Math.PI / 2);  // updateSky용 (camera 정의 전)
updateSky(45, 0.3); // 초기값 (낮, 부분적 구름)

// --- 구름 마스크 (저해상도 2D noise, 화면 전체 bilinear 업샘플링) ---
// cloudiness=0 → 전부 0, cloudiness=1 → 전부 0.8 이상
// 결정적 noise: 위치(경도/위도) + 날짜 단위. 프레임 단위 flicker 없음.
var CLOUD_W = 64, CLOUD_H = 18;  // 저해상도 노이즈 격자
var cloudMask = new Float32Array(CLOUD_W * CLOUD_H);
// Full-res 구름 알파 버퍼 (지평선 위쪽만). 30초 게임내시간마다 1회 업샘플.
var CLOUD_FULL_H = 200;  // 지평 위 최대 높이
var cloudFull = new Uint8ClampedArray(SCR_W * CLOUD_FULL_H);  // 0~255
var cloudLastKey = -1;
function cloudHash(ix, iy) {
    var h = ((ix | 0) * 374761393 ^ (iy | 0) * 668265263) >>> 0;
    h = (h ^ (h >>> 13)) * 1274126177 >>> 0;
    return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}
function cloudNoise2D(x, y) {
    // value noise (bilinear)
    var xi = Math.floor(x), yi = Math.floor(y);
    var xf = x - xi, yf = y - yi;
    var a = cloudHash(xi,     yi);
    var b = cloudHash(xi + 1, yi);
    var c = cloudHash(xi,     yi + 1);
    var d = cloudHash(xi + 1, yi + 1);
    var u = xf * xf * (3 - 2 * xf);
    var v = yf * yf * (3 - 2 * yf);
    return a * (1 - u) * (1 - v) + b * u * (1 - v) + c * (1 - u) * v + d * u * v;
}
function updateCloudMask() {
    // 갱신 주기: 30초 게임내시간. 과도한 flicker 방지.
    var key = (gameTime / 30000) | 0;
    if (key === cloudLastKey) return;
    cloudLastKey = key;
    var cloudi = weather.cloudiness;
    // 구름 pan: 경도·시간으로 offset
    var panX = sun.lon * 0.4 + key * 0.05;
    var panY = sun.lat * 0.3;
    // 구름량이 낮으면 마스크 전체 0, 높으면 임계값 낮춰 두껍게
    var thr = 1.1 - cloudi * 0.95;   // cloudi=1 → thr=0.15, cloudi=0 → 1.1 (항상 0)
    for (var cy = 0; cy < CLOUD_H; cy++) {
        for (var cx = 0; cx < CLOUD_W; cx++) {
            var u = (cx / CLOUD_W) * 8 + panX;
            var v = (cy / CLOUD_H) * 3 + panY;
            var n = cloudNoise2D(u, v) * 0.6 + cloudNoise2D(u * 2.1, v * 2.1) * 0.3 + cloudNoise2D(u * 4.3, v * 4.3) * 0.1;
            var m = n - thr;
            if (m < 0) m = 0;
            else if (m > 0.4) m = 0.4;
            cloudMask[cy * CLOUD_W + cx] = m * 2.5;  // 최대 1.0
        }
    }
    // Full-res 업샘플 (bilinear) — 한 번만.
    for (var fy = 0; fy < CLOUD_FULL_H; fy++) {
        var v = (fy / CLOUD_FULL_H) * (CLOUD_H - 1);
        var vi = v | 0; var vf = v - vi;
        if (vi >= CLOUD_H - 1) { vi = CLOUD_H - 2; vf = 1; }
        for (var fx = 0; fx < SCR_W; fx++) {
            var u = (fx / SCR_W) * (CLOUD_W - 1);
            var ui = u | 0; var uf = u - ui;
            if (ui >= CLOUD_W - 1) { ui = CLOUD_W - 2; uf = 1; }
            var aF = cloudMask[vi * CLOUD_W + ui];
            var bF = cloudMask[vi * CLOUD_W + ui + 1];
            var cF = cloudMask[(vi + 1) * CLOUD_W + ui];
            var dF = cloudMask[(vi + 1) * CLOUD_W + ui + 1];
            var val = aF * (1 - uf) * (1 - vf) + bF * uf * (1 - vf) + cF * (1 - uf) * vf + dF * uf * vf;
            cloudFull[fy * SCR_W + fx] = (val * 255) | 0;
        }
    }
}
// 화면 좌표 → cloudFull 인덱스(지평 위 0~CLOUD_FULL_H). 스크린 y가 horizon 근처일수록 mapped v가 작음.
function cloudAlphaAt(x, y, horizonY) {
    if (y >= horizonY || y < 0 || x < 0 || x >= SCR_W) return 0;
    // 지평선 = cloudFull 아래쪽, 천정 = cloudFull 위쪽. horizonY=y일 때 CLOUD_FULL_H-1.
    var fy = ((horizonY - y) / horizonY * (CLOUD_FULL_H - 1)) | 0;
    if (fy < 0) fy = 0; else if (fy >= CLOUD_FULL_H) fy = CLOUD_FULL_H - 1;
    return cloudFull[fy * SCR_W + x] / 255;
}

// --- 구간별 선형 매핑 (piecewise linear) ---
// Uint8 값 → 실제 미터 역변환 LUT (렌더링 시 구간별 scale 보정)
var SEGMENTS = [
    [-8000, -200,   0,  24],
    [ -200,  -10,  24,  48],
    [  -10,    0,  48,  64],
    [    0,   20,  64, 112],
    [   20,  200, 112, 160],
    [  200, 1000, 160, 208],
    [ 1000, 5000, 208, 255]
];
var heightMeters = new Float32Array(256);
for (var i = 0; i < 256; i++) {
    for (var s = 0; s < SEGMENTS.length; s++) {
        var seg = SEGMENTS[s];
        if (i <= seg[3] || s === SEGMENTS.length - 1) {
            var t = (seg[3] === seg[2]) ? 0 : (i - seg[2]) / (seg[3] - seg[2]);
            t = t < 0 ? 0 : t > 1 ? 1 : t;
            heightMeters[i] = seg[0] + t * (seg[1] - seg[0]);
            break;
        }
    }
}

// --- Colormap 생성 (heightmap → RGB + hillshading) ---
// generate_maps.py와 동일 알고리즘. 타일 경계는 edge replication.
// TODO: 인접 타일 로드되면 경계 1px 재계산하여 이음매 제거
// gtx, gty는 글로벌 타일 좌표 (디더링 좌표를 타일 경계에서 연속시키기 위함)
function generateColormap(h, W, H, gtx, gty) {
    W = W || TILE_SIZE;
    H = H || TILE_SIZE;
    gtx = gtx || 0;
    gty = gty || 0;
    var goxX = gtx * TILE_SIZE; // 글로벌 디더링 오프셋
    var goxY = gty * TILE_SIZE;
    var cmap = new Uint32Array(W * H);
    // 광원: 북서 45도
    var LX = Math.cos(Math.PI/4) * Math.sin(Math.PI * 315/180);
    var LY = Math.cos(Math.PI/4) * Math.cos(Math.PI * 315/180);
    var LZ = Math.sin(Math.PI/4);
    var SLOPE = 2.0, SLOPE_SQ = 4.0;

    for (var y = 0; y < H; y++) {
        var yUp = y > 0 ? y - 1 : 0;
        var yDn = y < H - 1 ? y + 1 : H - 1;
        var rowBase = y * W;
        var rowUp = yUp * W, rowDn = yDn * W;
        for (var x = 0; x < W; x++) {
            var xL = x > 0 ? x - 1 : 0;
            var xR = x < W - 1 ? x + 1 : W - 1;
            var idx = rowBase + x;
            var hi = h[idx];

            // Sobel gradient (edge replication)
            var dx = h[rowBase + xR] - h[rowBase + xL];
            var dy = h[rowDn + x]    - h[rowUp + x];

            // Hillshade
            var shade = -dx * SLOPE * LX - dy * SLOPE * LY + LZ;
            shade /= Math.sqrt(dx * dx * SLOPE_SQ + dy * dy * SLOPE_SQ + 1.0);
            if (shade < 0) shade = 0;
            else if (shade > 1) shade = 1;

            // 디더링 노이즈 (글로벌 좌표 기준 → 타일 경계 연속)
            var gX = goxX + x, gY = goxY + y;
            var n = (((gX * 7 + gY * 13) ^ (gX + gY * 3)) & 15) - 7;

            var r, g, b;
            if (hi <= SEA) {
                // 바다 — sqrt 커브로 shore 주변 연청록 대비 강조, 그 후 선형으로 심해 navy
                var xd = (SEA - hi) * (1/SEA);
                if (xd < 0) xd = 0; else if (xd > 1) xd = 1;
                var tt = Math.sqrt(xd); // shore 근처 급변
                r = 150 - tt * 132;  // 150 → 18
                g = 200 - tt * 158;  // 200 → 42
                b = 200 - tt * 100;  // 200 → 100
                r += n * 0.3; g += n * 0.3; b += n * 0.3;
                // 바다는 hillshading 적용 안함
            } else {
                // 육지 (고도별)
                var a = hi - SEA;
                var t;
                if (a < 6) {
                    r = 194; g = 178; b = 130;
                } else if (a < 48) {
                    t = (a - 6) / 42;
                    r = 50 + t * 25;  g = 100 + t * 30;  b = 30 + t * 10;
                } else if (a < 96) {
                    t = (a - 48) / 48;
                    r = 75 + t * 35;  g = 130 - t * 15;  b = 40 + t * 15;
                } else if (a < 130) {
                    t = (a - 96) / 34;
                    r = 110 + t * 30; g = 105 - t * 15;  b = 55 + t * 10;
                } else if (a < 155) {
                    t = (a - 130) / 25;
                    r = 140 - t * 15; g = 90 - t * 10;   b = 65 + t * 15;
                } else {
                    t = (a - 155) / 36;
                    if (t > 1) t = 1;
                    r = 125 + t * 30; g = 80 + t * 30;   b = 80 + t * 30;
                }
                r += n * 0.5; g += n * 0.5; b += n * 0.4;
                // hillshading
                var light = 0.35 + 0.65 * shade;
                r *= light; g *= light; b *= light;
            }

            r = r < 0 ? 0 : r > 255 ? 255 : r | 0;
            g = g < 0 ? 0 : g > 255 ? 255 : g | 0;
            b = b < 0 ? 0 : b > 255 ? 255 : b | 0;
            cmap[idx] = 0xFF000000 | (b << 16) | (g << 8) | r;
        }
    }
    return cmap;
}

// --- Load PNG heightmap & colormap ---
function loadImage(src) {
    return new Promise(function(resolve, reject) {
        var img = new Image();
        img.onload = function() { resolve(img); };
        img.onerror = reject;
        img.src = src;
    });
}

// --- 타일 시스템 ---
// 4x4 슬롯 버퍼 (2048x2048). 각 월드 타일 (tx, ty)는 슬롯 (tx%4, ty%4)에 배치.
// 글로벌 좌표 & 2047 = 버퍼 위치 자동 매핑 (3x3 이웃 내 타일은 슬롯 충돌 없음).
var altitude = new Uint8Array(SIZE * SIZE);
var colormap = new Uint32Array(SIZE * SIZE);
altitude.fill(SEA); // 기본값 바다
window.__altitude = altitude;
window.__colormap = colormap;

var slotTiles = new Array(BUF_TILES * BUF_TILES).fill(null); // key of tile in each slot
var loadingTiles = {};  // key → Promise
var tileIndex = null;

function pad2(n) { return n < 10 ? '0' + n : '' + n; }

// 타일 하나를 슬롯에 로드 (async). 이미 로드 중/완료면 스킵.
async function loadTile(tx, ty) {
    // 경도 wrap, 위도 clamp
    tx = ((tx % WORLD_TILES_X) + WORLD_TILES_X) % WORLD_TILES_X;
    if (ty < 0 || ty >= WORLD_TILES_Y) return;

    var key = tx + '_' + ty;
    var slotI = tx % BUF_TILES;
    var slotJ = ty % BUF_TILES;
    var slotIdx = slotJ * BUF_TILES + slotI;

    if (slotTiles[slotIdx] === key) return;       // 이미 로드됨
    if (loadingTiles[key]) return loadingTiles[key]; // 로딩 중

    var promise = (async function() {
        var heightRaw = new Uint8Array(TILE_SIZE * TILE_SIZE);
        var hasFile = tileIndex && tileIndex.tiles && tileIndex.tiles[key];

        if (hasFile) {
            try {
                var img = await loadImage('tiles/h_' + pad2(tx) + '_' + pad2(ty) + '.png');
                tmpCtx.clearRect(0, 0, TILE_SIZE, TILE_SIZE);
                tmpCtx.drawImage(img, 0, 0);
                var data = tmpCtx.getImageData(0, 0, TILE_SIZE, TILE_SIZE).data;
                for (var i = 0; i < TILE_SIZE * TILE_SIZE; i++) heightRaw[i] = data[i * 4];
            } catch (e) {
                heightRaw.fill(SEA); // 로드 실패 시 바다
            }
        } else {
            heightRaw.fill(SEA); // 인덱스에 없음 = 순수 바다
        }

        // 슬롯에 쓰기 (altitude + colormap)
        var tileCmap = generateColormap(heightRaw, TILE_SIZE, TILE_SIZE, tx, ty);
        var bx0 = slotI * TILE_SIZE;
        var by0 = slotJ * TILE_SIZE;
        for (var ly = 0; ly < TILE_SIZE; ly++) {
            var src = ly * TILE_SIZE;
            var dst = (by0 + ly) * SIZE + bx0;
            for (var lx = 0; lx < TILE_SIZE; lx++) {
                var h = heightRaw[src + lx];
                altitude[dst + lx] = h <= SEA ? SEA : h;
                colormap[dst + lx] = tileCmap[src + lx];
            }
        }
        slotTiles[slotIdx] = key;
        delete loadingTiles[key];
    })();

    loadingTiles[key] = promise;
    return promise;
}

// 현재 보트 위치 기준 5x5 타일 로드 (렌더 거리 800 커버)
function ensureTilesLoaded() {
    var ctx = Math.floor(boat.gx / TILE_SIZE);
    var cty = Math.floor(boat.gy / TILE_SIZE);
    for (var dy = -2; dy <= 2; dy++) {
        for (var dx = -2; dx <= 2; dx++) {
            loadTile(ctx + dx, cty + dy);
        }
    }
}

var tmpC, tmpCtx, boatImg;
try {
    // 1. 타일 인덱스 + 보트 이미지 로드
    var idxRes = await fetch('tiles/tile_index.json');
    tileIndex = await idxRes.json();
    boatImg = await loadImage('boat.png');

    tmpC = document.createElement('canvas');
    tmpC.width = TILE_SIZE; tmpC.height = TILE_SIZE;
    tmpCtx = tmpC.getContext('2d');

    // 2. 시작 위치: 북위 24°, 경도 126.55°E (하지 태양이 천정 지나는 위도 근처)
    //    gy = (ORIGIN_LAT - 24) / DEG_PER_PIXEL = 66 * 240 = 15840
    var startGx = 73572, startGy = 15840;

    // 3. 초기 5x5 타일 로드 (완료 대기)
    var startTx = Math.floor(startGx / TILE_SIZE);
    var startTy = Math.floor(startGy / TILE_SIZE);
    var initPromises = [];
    for (var dy = -2; dy <= 2; dy++) {
        for (var dx = -2; dx <= 2; dx++) {
            initPromises.push(loadTile(startTx + dx, startTy + dy));
        }
    }
    await Promise.all(initPromises);

    // boat.gx, boat.gy는 아래 boat 선언 후 초기화
    window.__startGx = startGx;
    window.__startGy = startGy;
} catch (e) {
    document.getElementById('loading').innerHTML =
        '로드 실패<br><br><small>터미널에서:<br>' +
        '<b>cd ~/works/tamra && python3 -m http.server 8080</b><br>' +
        '→ http://localhost:8080 접속</small>';
    return;
}

document.getElementById('loading').style.display = 'none';
canvas.style.display = 'block';
document.getElementById('hud').style.display = 'block';
var gameUiEl = document.getElementById('gameui');
gameUiEl.style.display = 'block';
var debugEl = document.getElementById('debug');
debugEl.style.display = 'block';

// --- Wave (파도) ---
var wave = {
    time: 0,
    // 큰 너울
    swell:  { dx: 0.10, dy: 0.08, speed: 1.0, amp: 2.5 },
    // 중간 파도
    mid:    { dx: 0.25, dy:-0.18, speed: 1.5, amp: 1.2 },
    // 잔물결
    ripple: { dx: 0.60, dy: 0.45, speed: 2.3, amp: 0.4 }
};

// --- Wind (풍향) ---
// 노이즈 블록 회전 축 → 동서남북으로 네모가 정렬되지 않게 함
// 0 = 북, π/2 = 동. 북동풍 = 45° 방향에서 오는 바람
// 풍향(angleRad) · 풍속(speedMS) — computeWind()가 매 프레임 갱신
var wind = { angleRad: Math.PI / 4, speedMS: 8 };
window.__wind = wind;

// --- Sail (돛 효율) ---
// boat.angle 과 wind.angleRad 의 상대각(AoA) → polar 계수
//   IRONS  0..30°  0.05 (맞바람, 거의 못감)
//   CLOSE  30..60° 0.55 (클로즈홀드)
//   BEAM   60..120° 1.00 (빔리치, 최적)
//   BROAD  120..160° 1.20 (브로드리치, 최고속)
//   RUN    160..180° 0.90 (런닝, 세일 그림자 효과)
// wind.speedMS / 8 (기준) 기준 0.3..1.8 clamp
var sail = { polar: 1.0, mode: 'BEAM', windFactor: 1.0 };
function polarFor(headingRad) {
    var rel = headingRad - wind.angleRad;
    rel = ((rel + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
    var aoa = Math.abs(rel);
    if (aoa < Math.PI / 6)        return 0.05;
    else if (aoa < Math.PI / 3)   return 0.55;
    else if (aoa < 2 * Math.PI / 3) return 1.00;
    else if (aoa < 8 * Math.PI / 9) return 1.20;
    else                          return 0.90;
}
function computeSail() {
    var rel = boat.angle - wind.angleRad;
    rel = ((rel + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
    var aoa = Math.abs(rel);
    if      (aoa < Math.PI / 6)     { sail.polar = 0.05; sail.mode = 'IRONS'; }
    else if (aoa < Math.PI / 3)     { sail.polar = 0.55; sail.mode = 'CLOSE'; }
    else if (aoa < 2 * Math.PI / 3) { sail.polar = 1.00; sail.mode = 'BEAM';  }
    else if (aoa < 8 * Math.PI / 9) { sail.polar = 1.20; sail.mode = 'BROAD'; }
    else                            { sail.polar = 0.90; sail.mode = 'RUN';   }
    var wf = wind.speedMS / 8;
    if (wf < 0.3) wf = 0.3; else if (wf > 1.8) wf = 1.8;
    sail.windFactor = wf;
}

// 선체 속도 합성: 돛 추진 + 해류 drift → ground velocity
function updateShipSpeed() {
    var sMS = boat.sailUp ? sail.polar * sail.windFactor * BASE_SAIL_SPEED : 0;
    ship.sailMS = sMS;
    // 돛 추진: 선수 방향. boat.angle 0=북 기준 세계좌표 벡터 (-sin, -cos)
    var sVx = -Math.sin(boat.angle) * sMS;
    var sVy = -Math.cos(boat.angle) * sMS;
    // 해류: flow direction (sin, -cos)
    var cVx =  Math.sin(current.angleRad) * current.speedMS;
    var cVy = -Math.cos(current.angleRad) * current.speedMS;
    var vx = sVx + cVx, vy = sVy + cVy;
    ship.groundMS = Math.hypot(vx, vy);
    // 합성 방향 — 세계좌표 벡터 → 표준 방위
    ship.groundDirRad = Math.atan2(vx, -vy);  // 0=북, π/2=동
    if (ship.groundDirRad < 0) ship.groundDirRad += 2 * Math.PI;
}
window.__sail = sail;

// --- Current (해류) ---
// 대양 대순환 근사 — flow direction (해류가 "흐르는" 방향, 바람과 반대 관습)
// 0 = 북쪽으로 흐름, π/2 = 동쪽으로 흐름
var current = { angleRad: 0, speedMS: 0 };
function computeCurrent() {
    var lat = sun.lat, lon = sun.lon;
    var a = Math.abs(lat);
    var dir, spd;
    if      (a < 20) { dir = 270; spd = 0.4; }    // 적도류 (W)
    else if (a < 35) { dir = 90;  spd = 0.2; }    // 아열대 환류 동쪽 가장자리
    else if (a < 55) { dir = 90;  spd = 0.3; }    // 편서풍대 (북태평양)
    else if (a < 65) { dir = 270; spd = 0.2; }    // 아극지 반류
    else             { dir = 90;  spd = 0.1; }    // 극지

    // 서안경계류 — 쿠로시오 (아시아 동안, 북반구)
    if (lon > 110 && lon < 150 && lat > 20 && lat < 45) {
        dir = 45; spd = 1.2;
    }
    // 남반구 대칭 (동호주 해류)
    if (lon > 140 && lon < 170 && lat > -45 && lat < -20) {
        dir = 225; spd = 1.0;
    }

    // 결정적 noise (위치·년도)
    var seed = (Math.floor(lat * 2) + Math.floor(lon * 2) * 11 + sun.year * 7) >>> 0;
    var n = ((seed * 2654435761) >>> 0) / 4294967295;
    dir += (n - 0.5) * 20;
    spd *= 0.8 + n * 0.4;

    dir = ((dir % 360) + 360) % 360;
    current.angleRad = dir * Math.PI / 180;
    current.speedMS = spd;
}
window.__current = current;

// --- Wave 방향·진폭을 바람·해류에 연동 ---
// swell(너울) ← 해류, mid/ripple ← 바람. 진폭은 풍속 비례.
function computeWaves() {
    var K_SWELL = 0.128, K_MID = 0.31, K_RIPPLE = 0.75;
    var windFlow = wind.angleRad + Math.PI;  // 바람이 "부는" 방향
    var curFlow  = current.angleRad;         // 해류 flow direction
    wave.swell.dx  =  Math.sin(curFlow)  * K_SWELL;
    wave.swell.dy  = -Math.cos(curFlow)  * K_SWELL;
    wave.mid.dx    =  Math.sin(windFlow) * K_MID;
    wave.mid.dy    = -Math.cos(windFlow) * K_MID;
    wave.ripple.dx =  Math.sin(windFlow) * K_RIPPLE;
    wave.ripple.dy = -Math.cos(windFlow) * K_RIPPLE;
    var ampF = wind.speedMS / 8;
    if (ampF < 0.2) ampF = 0.2; else if (ampF > 2.0) ampF = 2.0;
    wave.swell.amp  = 2.5 * Math.max(0.5, ampF);
    wave.mid.amp    = 1.2 * ampF;
    wave.ripple.amp = 0.4 * ampF;
}
window.__wave = wave;

// --- 별 데이터 (J2000 RA시 / Dec도 / 겉보기등급) ---
// 밝은 별 + 주요 별자리(북두칠성·카시오페이아·오리온·백조·전갈·사자·큰개·남십자)
// 멤버 별 포함. 별자리 선은 LINES 배열로 구성.
var STARS = [
    // 1등급 이하 주요 항성
    { ra: 6.752, dec:-16.72, mag:-1.46, n:'Sirius'    },
    { ra: 6.399, dec:-52.70, mag:-0.74, n:'Canopus'   },
    { ra:14.660, dec:-60.83, mag:-0.27, n:'AlphaCen'  },
    { ra:14.261, dec: 19.18, mag:-0.05, n:'Arcturus'  },
    { ra:18.616, dec: 38.78, mag: 0.03, n:'Vega'      },
    { ra: 5.278, dec: 45.99, mag: 0.08, n:'Capella'   },
    { ra: 5.242, dec: -8.20, mag: 0.13, n:'Rigel'     },
    { ra: 7.655, dec:  5.22, mag: 0.38, n:'Procyon'   },
    { ra: 5.919, dec:  7.41, mag: 0.50, n:'Betelgeuse'},
    { ra: 1.629, dec:-57.24, mag: 0.45, n:'Achernar'  },
    { ra:14.064, dec:-60.37, mag: 0.61, n:'Hadar'     },
    { ra:19.846, dec:  8.87, mag: 0.77, n:'Altair'    },
    { ra:12.443, dec:-63.10, mag: 0.77, n:'Acrux'     },
    { ra: 4.599, dec: 16.51, mag: 0.85, n:'Aldebaran' },
    { ra:16.490, dec:-26.43, mag: 1.06, n:'Antares'   },
    { ra:13.420, dec:-11.16, mag: 1.04, n:'Spica'     },
    { ra: 7.755, dec: 28.03, mag: 1.14, n:'Pollux'    },
    { ra: 7.577, dec: 31.89, mag: 1.58, n:'Castor'    },
    { ra:22.961, dec:-29.62, mag: 1.16, n:'Fomalhaut' },
    { ra:20.691, dec: 45.28, mag: 1.25, n:'Deneb'     },
    { ra:12.795, dec:-59.69, mag: 1.25, n:'Mimosa'    },
    { ra:10.140, dec: 11.97, mag: 1.35, n:'Regulus'   },
    { ra: 2.530, dec: 89.26, mag: 1.98, n:'Polaris'   },
    // 오리온
    { ra: 5.679, dec: -1.94, mag: 1.74, n:'Alnitak'   },
    { ra: 5.603, dec: -1.20, mag: 1.69, n:'Alnilam'   },
    { ra: 5.533, dec: -0.30, mag: 2.23, n:'Mintaka'   },
    { ra: 5.796, dec: -9.67, mag: 2.09, n:'Saiph'     },
    { ra: 5.418, dec:  6.35, mag: 1.64, n:'Bellatrix' },
    // 남십자
    { ra:12.519, dec:-57.11, mag: 1.63, n:'Gacrux'    },
    { ra:12.253, dec:-58.75, mag: 2.79, n:'Imai'      },
    // 북두칠성 (큰곰자리 국자 부분)
    { ra:11.062, dec: 61.75, mag: 1.79, n:'Dubhe'     },
    { ra:11.030, dec: 56.38, mag: 2.37, n:'Merak'     },
    { ra:11.897, dec: 53.69, mag: 2.44, n:'Phecda'    },
    { ra:12.257, dec: 57.03, mag: 3.31, n:'Megrez'    },
    { ra:12.900, dec: 55.96, mag: 1.77, n:'Alioth'    },
    { ra:13.399, dec: 54.92, mag: 2.23, n:'Mizar'     },
    { ra:13.792, dec: 49.31, mag: 1.85, n:'Alkaid'    },
    // 카시오페이아 (W자)
    { ra: 0.675, dec: 56.54, mag: 2.24, n:'Schedar'   },
    { ra: 0.153, dec: 59.15, mag: 2.28, n:'Caph'      },
    { ra: 0.945, dec: 60.72, mag: 2.47, n:'GammaCas'  },
    { ra: 1.431, dec: 60.24, mag: 2.68, n:'Ruchbah'   },
    { ra: 1.907, dec: 63.67, mag: 3.38, n:'Segin'     },
    // 백조자리 (북십자)
    { ra:20.370, dec: 40.26, mag: 2.23, n:'Sadr'      },
    { ra:20.770, dec: 33.97, mag: 2.48, n:'GienahCyg' },
    { ra:19.750, dec: 45.13, mag: 2.87, n:'DeltaCyg'  },
    { ra:19.512, dec: 27.96, mag: 3.18, n:'Albireo'   },
    // 전갈자리
    { ra:17.560, dec:-37.10, mag: 1.63, n:'Shaula'    },
    { ra:17.622, dec:-42.99, mag: 1.87, n:'Sargas'    },
    { ra:16.005, dec:-19.80, mag: 2.89, n:'Dschubba'  },
    { ra:16.836, dec:-34.29, mag: 1.86, n:'Epsilon'   },
    // 사자자리
    { ra:11.818, dec: 14.57, mag: 2.11, n:'Denebola'  },
    { ra:10.333, dec: 19.84, mag: 2.08, n:'Algieba'   },
    { ra:11.237, dec: 20.52, mag: 2.56, n:'Zosma'     },
    // 큰개자리 (Sirius 주변)
    { ra: 6.378, dec:-17.96, mag: 1.98, n:'Mirzam'    },
    { ra: 6.977, dec:-28.97, mag: 1.50, n:'Adhara'    },
    { ra: 7.140, dec:-26.39, mag: 1.83, n:'Wezen'     },
    // 독수리자리 (Altair 보조)
    { ra:19.770, dec: 10.61, mag: 2.72, n:'Tarazed'   },
    { ra:19.922, dec:  6.41, mag: 3.71, n:'Alshain'   },
    // 처녀자리 (Spica 주변)
    { ra:13.037, dec: 10.96, mag: 2.85, n:'Vindem'    },
    { ra:12.694, dec: -1.45, mag: 2.74, n:'Porrima'   },
    { ra:12.927, dec:  3.40, mag: 3.38, n:'Auva'      },
    // 고래자리
    { ra: 0.726, dec:-17.99, mag: 2.04, n:'Diphda'    },
    { ra: 3.038, dec:  4.09, mag: 2.53, n:'Menkar'    },
    // 물병자리
    { ra:21.526, dec: -5.57, mag: 2.91, n:'Sadalsuud' },
    { ra:22.096, dec: -0.32, mag: 2.95, n:'Sadalmelik'},
    // 양자리
    { ra: 2.120, dec: 23.46, mag: 2.00, n:'Hamal'     },
    { ra: 1.911, dec: 20.81, mag: 2.64, n:'Sheratan'  },
    // 황소자리 (플레이아데스 포함)
    { ra: 5.438, dec: 28.61, mag: 1.65, n:'Elnath'    },
    { ra: 3.791, dec: 24.11, mag: 2.87, n:'Alcyone'   },
    // 궁수자리 (남쪽 주전자)
    { ra:18.403, dec:-34.38, mag: 1.85, n:'KausAust'  },
    { ra:18.921, dec:-26.30, mag: 2.05, n:'Nunki'     },
    // 마차부자리
    { ra: 5.992, dec: 44.95, mag: 1.90, n:'Menkalinan'},
    // 페가수스자리 (대사각형)
    { ra:23.079, dec: 15.21, mag: 2.49, n:'Markab'    },
    { ra:23.063, dec: 28.08, mag: 2.42, n:'Scheat'    },
    { ra: 0.221, dec: 15.18, mag: 2.83, n:'Algenib'   },
    { ra:21.737, dec:  9.87, mag: 2.40, n:'Enif'      },
    // 안드로메다자리
    { ra: 0.140, dec: 29.09, mag: 2.06, n:'Alpheratz' },
    { ra: 1.162, dec: 35.62, mag: 2.07, n:'Mirach'    },
    { ra: 2.065, dec: 42.33, mag: 2.26, n:'Almach'    },
    // 페르세우스자리
    { ra: 3.405, dec: 49.86, mag: 1.79, n:'Mirfak'    },
    { ra: 3.136, dec: 40.96, mag: 2.12, n:'Algol'     },
    // 왕관자리
    { ra:15.578, dec: 26.71, mag: 2.23, n:'Alphecca'  },
    // 뱀주인자리
    { ra:17.582, dec: 12.56, mag: 2.07, n:'Rasalhague'},
    // 돛자리
    { ra: 9.134, dec:-43.43, mag: 2.21, n:'Suhail'    },
    { ra: 8.745, dec:-54.71, mag: 1.93, n:'Alsephina' },
    // 용골자리
    { ra: 9.220, dec:-69.72, mag: 1.67, n:'Miaplacidus'},
    { ra: 8.375, dec:-59.51, mag: 1.86, n:'Avior'     },
    // 공작자리
    { ra:20.427, dec:-56.74, mag: 1.94, n:'Peacock'   },
    // 쌍둥이 추가
    { ra: 6.628, dec: 16.40, mag: 1.92, n:'Alhena'    },
    // 거문고자리 추가
    { ra:18.982, dec: 32.69, mag: 3.25, n:'Sulafat'   },
    // 작은곰자리 (Polaris 보조)
    { ra:14.845, dec: 74.16, mag: 2.08, n:'Kochab'    },
    { ra:15.345, dec: 71.83, mag: 3.00, n:'Pherkad'   },
    // 용자리
    { ra:17.943, dec: 51.49, mag: 2.24, n:'Eltanin'   },
    { ra:17.507, dec: 52.30, mag: 2.79, n:'Rastaban'  },
    // 케페우스자리
    { ra:21.309, dec: 62.59, mag: 2.46, n:'Alderamin' },
    // 이리자리
    { ra:14.698, dec:-47.39, mag: 2.30, n:'AlphaLup'  },
    { ra:14.975, dec:-43.13, mag: 2.68, n:'BetaLup'   }
];
// alt/az 캐시 (매 프레임 갱신)
// 은하수 대역 — 은하 평면(galactic plane) 샘플 포인트를 RA/Dec로 표현.
// galactic latitude b=0 대원을 J2000 적도좌표로 투영한 근사 ~72점.
// 궁수자리(은하중심 RA≈266°, Dec≈-29°)에서 시작, 방패·독수리·백조·카시오페이아·마차부·오리온·선미자리까지.
var MILKYWAY = (function () {
    var pts = [];
    // galactic longitude l (0~360°)를 5° 간격으로 샘플 → 적도좌표 변환
    // 변환식: sinδ = sinδ_NGP cosb + cosδ_NGP sinb cos(l_NGP - l)
    //         tan(α-α_NGP) = cosb sin(l_NGP-l) / (sinb cosδ_NGP - cosb sinδ_NGP cos(l_NGP-l))
    //   J2000: α_NGP=192.859°, δ_NGP=27.128°, l_NGP=122.932°
    var aNGP = 192.859 * Math.PI / 180;
    var dNGP = 27.128 * Math.PI / 180;
    var lNGP = 122.932 * Math.PI / 180;
    var sinDN = Math.sin(dNGP), cosDN = Math.cos(dNGP);
    for (var l = 0; l < 360; l += 5) {
        var lRad = l * Math.PI / 180;
        var b = 0;  // 은하 평면
        var sinD = Math.sin(b) * sinDN + Math.cos(b) * cosDN * Math.cos(lNGP - lRad);
        var dec = Math.asin(sinD);
        var y = Math.cos(b) * Math.sin(lNGP - lRad);
        var x = Math.sin(b) * cosDN - Math.cos(b) * sinDN * Math.cos(lNGP - lRad);
        var ra = aNGP - Math.atan2(y, x);
        ra = ((ra % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
        // 밀도 가중: 은하중심(l=0) 근처에서 최대, 반중심(l=180)에서 최소
        var dens;
        var la = Math.abs(((l + 180) % 360) - 180);  // 0 at center, 180 at anticenter
        dens = 1 - la / 180;           // 0~1
        dens = 0.25 + dens * dens * 0.75;
        pts.push({ ra: ra * 12 / Math.PI, dec: dec * 180 / Math.PI, dens: dens });
    }
    return pts;
})();
var milkyState = MILKYWAY.map(function () { return { altRad: 0, azRad: 0 }; });

var starState = STARS.map(function() { return { altRad: 0, azRad: 0 }; });
// 별 twinkle 위상·주파수 (결정적, 한 번만 초기화)
var starTwinklePhase = new Float32Array(STARS.length);
var starTwinkleFreq  = new Float32Array(STARS.length);
(function initTwinkle() {
    for (var i = 0; i < STARS.length; i++) {
        // RA·Dec 해시로 결정적 phase/freq (Math.random 쓰지 않음 — 재현성)
        var h = (STARS[i].ra * 73.0 + STARS[i].dec * 31.0);
        starTwinklePhase[i] = (h % (Math.PI * 2));
        starTwinkleFreq[i]  = 1.5 + ((h * 17) % 10) / 10 * 2.5;  // 1.5~4.0 Hz
    }
})();

// --- 태양계 행성 (J2000 평균 궤도요소; Meeus-ch31 간이식) ---
// 반장반경 AU, 이심률, 궤도경사·승교점·근일점경도 (deg)
// L0: 평균경도, nd: 일일 평균운동 (deg/day)
var PLANETS = [
    // color — 맨눈으로 실제 관측한 색감에 가까운 파스텔 (채도 낮게)
    { n:'Mercury', L0:252.250906, nd:4.092353837, a:0.387098310, e:0.205634283, i:7.004986, Om: 48.330893, wbar: 77.456119, color:0xFFDEE5EA },
    { n:'Venus',   L0:181.979801, nd:1.602130374, a:0.723329820, e:0.006771882, i:3.394662, Om: 76.679920, wbar:131.563707, color:0xFFEEF4F8 },
    { n:'Mars',    L0:355.433000, nd:0.524033017, a:1.523679342, e:0.093392770, i:1.849726, Om: 49.558093, wbar:336.060234, color:0xFF90B4F0 },
    { n:'Jupiter', L0: 34.351519, nd:0.083091379, a:5.202603191, e:0.048494832, i:1.303270, Om:100.464407, wbar: 14.331207, color:0xFFD2EBFA },
    { n:'Saturn',  L0: 50.077444, nd:0.033459652, a:9.554909596, e:0.055508622, i:2.488878, Om:113.665503, wbar: 93.056787, color:0xFFB0E5F5 },
    { n:'Uranus',  L0:314.055005, nd:0.011731294, a:19.218446062, e:0.046381, i:0.773196, Om: 74.005947, wbar:173.005159, color:0xFFDEE8D8 },
    { n:'Neptune', L0:304.348665, nd:0.005981841, a:30.110386869, e:0.009456, i:1.769952, Om:131.784057, wbar: 48.123691, color:0xFFE0C8B8 }
];
var EARTH = { L0:100.466449, nd:0.985609101, a:1.000000262, e:0.016708634, Om:0, wbar:102.937348, i:0 };
var planetState = PLANETS.map(function() { return { altRad: 0, azRad: 0, mag: 0 }; });
function heliocentric(el, Tdays) {
    var DEG = Math.PI / 180;
    var M = ((el.L0 + el.nd * Tdays - el.wbar) % 360) * DEG;
    // 뉴턴법 Kepler
    var E = M + el.e * Math.sin(M);
    for (var k = 0; k < 4; k++) {
        E = E - (E - el.e * Math.sin(E) - M) / (1 - el.e * Math.cos(E));
    }
    var xOrb = el.a * (Math.cos(E) - el.e);
    var yOrb = el.a * Math.sqrt(1 - el.e * el.e) * Math.sin(E);
    var w  = (el.wbar - el.Om) * DEG;
    var Om = el.Om * DEG;
    var iR = el.i * DEG;
    var cosW = Math.cos(w),  sinW = Math.sin(w);
    var cosO = Math.cos(Om), sinO = Math.sin(Om);
    var cosI = Math.cos(iR), sinI = Math.sin(iR);
    // 근일점 → 궤도평면 xy
    var x1 = cosW * xOrb - sinW * yOrb;
    var y1 = sinW * xOrb + cosW * yOrb;
    // 궤도평면 → 황도 평면 (경사)
    var x2 = x1;
    var y2 = y1 * cosI;
    var z2 = y1 * sinI;
    // 승교점 회전 → 황도 XYZ
    return {
        x: cosO * x2 - sinO * y2,
        y: sinO * x2 + cosO * y2,
        z: z2
    };
}
function updatePlanets(Tdays, gmstH, latRad, lonDeg) {
    var DEG = Math.PI / 180;
    var eps = 23.439281 * DEG;
    var eh = heliocentric(EARTH, Tdays);
    var lst = gmstH + lonDeg / 15;
    var sinLat = Math.sin(latRad), cosLat = Math.cos(latRad);
    for (var i = 0; i < PLANETS.length; i++) {
        var ph = heliocentric(PLANETS[i], Tdays);
        var X = ph.x - eh.x;
        var Y = ph.y - eh.y;
        var Z = ph.z - eh.z;
        var dist = Math.sqrt(X*X + Y*Y + Z*Z);
        // 황도 → 적도
        var Xe = X;
        var Ye = Y * Math.cos(eps) - Z * Math.sin(eps);
        var Ze = Y * Math.sin(eps) + Z * Math.cos(eps);
        var raRad = Math.atan2(Ye, Xe);
        if (raRad < 0) raRad += 2 * Math.PI;
        var decRad = Math.asin(Ze / dist);
        var raH = raRad * 12 / Math.PI;
        var H = (lst - raH) * 15 * DEG;
        var sinDec = Math.sin(decRad), cosDec = Math.cos(decRad);
        var sinH = Math.sin(H), cosH = Math.cos(H);
        var sinAlt = sinLat * sinDec + cosLat * cosDec * cosH;
        if (sinAlt > 1) sinAlt = 1; else if (sinAlt < -1) sinAlt = -1;
        planetState[i].altRad = Math.asin(sinAlt);
        var azRad = Math.atan2(-cosDec * sinH, sinDec * cosLat - cosDec * sinLat * cosH);
        if (azRad < 0) azRad += 2 * Math.PI;
        planetState[i].azRad = azRad;
        // 대략적 등급 (거리 기반 근사)
        planetState[i].mag = [
            -0.6, -4.2, -1.0, -2.5, 0.4, 5.7, 7.8
        ][i];
    }
}

// --- 달 위치 · 위상 (Meeus 간이식) ---
var moonState = { altRad: 0, azRad: 0, phase: 0, illumination: 0 };
function updateMoon(Tdays, gmstH, latRad, lonDeg) {
    var DEG = Math.PI / 180;
    var T = Tdays / 36525;
    var Lp = (218.3164477 + 481267.88123421 * T) * DEG;
    var D  = (297.8501921 + 445267.1114034 * T) * DEG;
    var M  = (357.5291092 +  35999.0502909 * T) * DEG;
    var Mp = (134.9633964 + 477198.8675055 * T) * DEG;
    var F  = ( 93.2720950 + 483202.0175233 * T) * DEG;
    var lambda = Lp
        + 6.289 * DEG * Math.sin(Mp)
        - 1.274 * DEG * Math.sin(Mp - 2 * D)
        + 0.658 * DEG * Math.sin(2 * D)
        + 0.214 * DEG * Math.sin(2 * Mp)
        - 0.186 * DEG * Math.sin(M)
        - 0.114 * DEG * Math.sin(2 * F);
    var beta = 5.128 * DEG * Math.sin(F)
        + 0.281 * DEG * Math.sin(Mp + F)
        - 0.278 * DEG * Math.sin(F - Mp)
        - 0.173 * DEG * Math.sin(F - 2 * D);
    var eps = 23.439281 * DEG;
    var cosL = Math.cos(lambda), sinL = Math.sin(lambda);
    var cosB = Math.cos(beta), sinB = Math.sin(beta);
    var x = cosL * cosB;
    var y = sinL * cosB * Math.cos(eps) - sinB * Math.sin(eps);
    var z = sinL * cosB * Math.sin(eps) + sinB * Math.cos(eps);
    var raRad = Math.atan2(y, x);
    if (raRad < 0) raRad += 2 * Math.PI;
    var decRad = Math.asin(z);
    var raH = raRad * 12 / Math.PI;
    var lst = gmstH + lonDeg / 15;
    var H = (lst - raH) * 15 * DEG;
    var sinLat = Math.sin(latRad), cosLat = Math.cos(latRad);
    var sinDec = Math.sin(decRad), cosDec = Math.cos(decRad);
    var sinH = Math.sin(H), cosH = Math.cos(H);
    var sinAlt = sinLat * sinDec + cosLat * cosDec * cosH;
    if (sinAlt > 1) sinAlt = 1; else if (sinAlt < -1) sinAlt = -1;
    moonState.altRad = Math.asin(sinAlt);
    var azRad = Math.atan2(-cosDec * sinH, sinDec * cosLat - cosDec * sinLat * cosH);
    if (azRad < 0) azRad += 2 * Math.PI;
    moonState.azRad = azRad;
    // 위상 (태양-달 황경 차이의 근사)
    var phaseRad = (D) % (2 * Math.PI);  // D = moon-sun elongation 평균
    if (phaseRad < 0) phaseRad += 2 * Math.PI;
    moonState.phase = phaseRad;   // 0 신월, π 보름
    moonState.illumination = (1 - Math.cos(phaseRad)) / 2;
}
window.__stars = STARS;
window.__starState = starState;
window.__planets = PLANETS;
window.__planetState = planetState;
window.__moonState = moonState;

// --- Weather (구름·시정) ---
// cloudiness 0..1, visibilityCoef 0.5..1.0 (시정 거리 배율)
var weather = { cloudiness: 0.3, visibilityCoef: 1.0, precipitation: 0, precipType: 'rain' };
function computeWeather() {
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
window.__weather = weather;
function updateStars() {
    // J2000 = 2000-01-01 12:00 UTC = Unix ms 946728000000. T in days from J2000.
    var Tdays = (gameTime / 86400000) - 10957.5;
    // GMST (hours)
    var gmst = 18.697374558 + 24.06570982441908 * Tdays;
    // LST (hours) — 경도 보정
    var lst = gmst + sun.lon / 15;
    var latRad = sun.lat * Math.PI / 180;
    var sinLat = Math.sin(latRad), cosLat = Math.cos(latRad);
    for (var i = 0; i < STARS.length; i++) {
        var s = STARS[i];
        var decRad = s.dec * Math.PI / 180;
        var H = (lst - s.ra) * 15 * Math.PI / 180;  // 시간각 rad
        var sinDec = Math.sin(decRad), cosDec = Math.cos(decRad);
        var sinH = Math.sin(H), cosH = Math.cos(H);
        var sinAlt = sinLat * sinDec + cosLat * cosDec * cosH;
        if (sinAlt > 1) sinAlt = 1; else if (sinAlt < -1) sinAlt = -1;
        var altRad = Math.asin(sinAlt);
        var azRad = Math.atan2(-cosDec * sinH, sinDec * cosLat - cosDec * sinLat * cosH);
        if (azRad < 0) azRad += 2 * Math.PI;
        starState[i].altRad = altRad;
        starState[i].azRad = azRad;
    }
    // 은하수 샘플 포인트 alt/az 변환 (별과 동일 알고리즘)
    for (var mi = 0; mi < MILKYWAY.length; mi++) {
        var mw = MILKYWAY[mi];
        var mDecRad = mw.dec * Math.PI / 180;
        var mH = (lst - mw.ra) * 15 * Math.PI / 180;
        var mSinDec = Math.sin(mDecRad), mCosDec = Math.cos(mDecRad);
        var mSinH = Math.sin(mH), mCosH = Math.cos(mH);
        var mSinAlt = sinLat * mSinDec + cosLat * mCosDec * mCosH;
        if (mSinAlt > 1) mSinAlt = 1; else if (mSinAlt < -1) mSinAlt = -1;
        var mAltRad = Math.asin(mSinAlt);
        var mAzRad = Math.atan2(-mCosDec * mSinH, mSinDec * cosLat - mCosDec * sinLat * mCosH);
        if (mAzRad < 0) mAzRad += 2 * Math.PI;
        milkyState[mi].altRad = mAltRad;
        milkyState[mi].azRad = mAzRad;
    }
    updatePlanets(Tdays, gmst, latRad, sun.lon);
    updateMoon(Tdays, gmst, latRad, sun.lon);
}
// debug: camera 전역 접근

// --- Boat (플레이어 조종 대상) ---
// gx, gy는 글로벌 월드 좌표 (0~WORLD_W, 0~WORLD_H)
// sailUp: 돛 펼침 상태 (바람 + 돛 폴라에 따라 자동 전진)
var boat = { gx: window.__startGx, gy: window.__startGy, angle: Math.PI, sailUp: true };
window.__boat = boat; // 디버그: 외부에서 위치 조작
// 기준 항해 속도: polar=1 · windFactor=1 (풍속 8 m/s 빔리치) 기준 4 m/s
var BASE_SAIL_SPEED = 4;
// ship 속도 상태: sail 추진, ground(해류 합성), heading
var ship = { sailMS: 0, groundMS: 0, groundDirRad: 0 };
window.__ship = ship;

// --- Camera (3인칭: 배 뒤에서 추적) ---
var BASE_CAM_METERS = 50;       // 기본 카메라 높이 (meters, ~배 위 시점)
var CAM_HEIGHT_MARGIN = 20;     // 카메라 아래 지형 있을 때 띄울 여유 (m)
// camera.x, camera.y는 글로벌 월드 좌표 (렌더 루프에서 & MASK로 버퍼 위치 매핑)
var camera = {
    x: boat.gx, y: boat.gy,
    heightMeters: BASE_CAM_METERS,
    angle: 0.0,
    horizon: 180,
    distance: 800
};
window.__camera = camera;

// --- Input ---
var input = {
    forwardbackward: 0,
    leftright: 0
};

var time = new Date().getTime();

// --- Sun / Game time state ---
// 시뮬 시각 (ms). 하지(6/21) 로컬 solar 정오 시작
//   utcH = 12 - lon/15 = 12 - 126.55/15 ≈ 3.56 ⇒ 03:34 UTC
var gameTime = Date.UTC(new Date().getUTCFullYear(), 5, 21, 3, 34, 0);
// 디버그: 콘솔에서 시간 제어 (window.__advanceHours(10), window.__setTimeSpeed(1))
window.__advanceHours = function (h) { gameTime += 3600000 * h; };
window.__setTimeSpeed = function (s) { TIME_SPEED = s; };
var sun = {
    lat: 0, lon: 0,
    altDeg: 45, azDeg: 180,
    altRad: 0, azRad: 0,
    dayOfYear: 0, hourLocal: 12, month: 1, date: 1, year: 2000
};
window.__sun = sun;
window.__setGameTime = function (ms) { gameTime = ms; };
window.__getGameTime = function () { return gameTime; };

function computeSun() {
    // 보트 위치 → 위/경도
    var lat = ORIGIN_LAT - boat.gy * DEG_PER_PIXEL;
    var lon = ORIGIN_LON + boat.gx * DEG_PER_PIXEL;
    lon = ((lon + 180) % 360 + 360) % 360 - 180;
    sun.lat = lat;
    sun.lon = lon;

    var d = new Date(gameTime);
    var yearStart = Date.UTC(d.getUTCFullYear(), 0, 0);
    var dayOfYear = Math.floor((gameTime - yearStart) / 86400000);

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
computeSun();

// --- 지역·계절·시간별 바람 (대기 대순환 근사) ---
function computeWind() {
    var lat = sun.lat, lon = sun.lon;
    var day = sun.dayOfYear, hr = sun.hourLocal;

    // 계절별 위도대 shift (여름 +5°, 겨울 -5°)
    var shift = 5 * Math.sin(2 * Math.PI * (day - 81) / 365);
    var eff = lat - shift;
    var a = Math.abs(eff);

    var dir, spd;
    if (a < 5)        { dir = eff > 0 ? 45 : 135;   spd = 2;  }   // ITCZ
    else if (a < 30)  { dir = eff > 0 ? 45 : 135;   spd = 8;  }   // 무역풍
    else if (a < 35)  { dir = eff > 0 ? 135 : 45;   spd = 3;  }   // 말 위도
    else if (a < 60)  { dir = eff > 0 ? 225 : 315;  spd = 12; }   // 편서풍
    else              { dir = eff > 0 ? 45 : 135;   spd = 5;  }   // 극동풍

    // 아시아 몬순 (Indian Ocean / SE Asia)
    if (lon > 60 && lon < 150 && lat > -20 && lat < 30) {
        if (day > 120 && day < 270)     { dir = 225; spd = 10; } // SW 몬순
        else if (day > 300 || day < 60) { dir = 45;  spd = 8;  } // NE 몬순
    }

    // 해륙풍 근사 (낮/밤 약한 sin 변조)
    var night = Math.sin(2 * Math.PI * hr / 24);
    dir += night * 8;
    spd *= 1 + night * 0.1;

    // 결정적 noise (위치 0.2° + 주 단위 + 년도)
    var seed = (Math.floor(lat * 5) + Math.floor(lon * 5) * 7 + Math.floor(day / 7) * 13 + sun.year * 31) >>> 0;
    var n = ((seed * 2654435761) >>> 0) / 4294967295;
    dir += (n - 0.5) * 30;
    spd *= 0.7 + n * 0.6;

    dir = ((dir % 360) + 360) % 360;
    if (spd < 0) spd = 0;

    wind.angleRad = dir * Math.PI / 180;
    wind.speedMS = spd;
}
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
            TIME_SPEED = Math.max(TIME_SPEED_MIN, TIME_SPEED / 2);
            uiBlip(440);
            break;
        case 89: // 'Y' : 시간 가속 ×2
            TIME_SPEED = Math.min(TIME_SPEED_MAX, TIME_SPEED * 2);
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
                    var nR = (bR0 + (skyGlowR - bR0) * a) | 0;
                    var nG = (bG0 + (skyGlowG - bG0) * a) | 0;
                    var nB = (bB0 + (skyGlowB - bB0) * a) | 0;
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
    var dtMs = nowMs - time;

    // 게임 시간 누적 (TIME_SPEED 배속). 하늘보기 중엔 정지.
    if (!skyMapOn) gameTime += dtMs * TIME_SPEED;

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
    var gameDt = skyMapOn ? 0 : (dtMs * TIME_SPEED) / 1000;
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

    time = nowMs;
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
    var bucket = (gameTime / 30000) | 0;
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
var FRAME_INTERVAL = 1000 / 20; // 50ms
var FRAME_EPSILON = 8;           // rAF 지터 허용 (half-period)
var lastDrawTime = 0;
var fpsFrames = 0, fpsStart = 0, fpsCurrent = 0;
// Frame time (EMA): Draw 한 번의 전체 소요 시간 (ms). 20fps cap 대기는 미포함.
var frameTimeEma = 0;

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
        'Time:    ' + hhmm + '  (x' + TIME_SPEED + ')\n' +
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
        'FPS:     ' + fpsCurrent + '\n' +
        'Frame:   ' + frameTimeEma.toFixed(2) + 'ms';
}

function Draw(now) {
    window.requestAnimationFrame(Draw);
    if (now === undefined) now = performance.now();
    if (now - lastDrawTime < FRAME_INTERVAL - FRAME_EPSILON) return;
    lastDrawTime = now;

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
    frameTimeEma = frameTimeEma === 0 ? frameDur : frameTimeEma * 0.9 + frameDur * 0.1;

    // FPS 1초 간격 갱신
    fpsFrames++;
    if (fpsStart === 0) fpsStart = now;
    if (now - fpsStart >= 1000) {
        fpsCurrent = Math.round(fpsFrames * 1000 / (now - fpsStart));
        fpsFrames = 0;
        fpsStart = now;
    }
    UpdateDebug();
}

// Initial render
Draw();
})();
