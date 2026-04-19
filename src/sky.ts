// sky.ts — 하늘 팔레트(낮/황혼/밤 blend) + 대기광 separable (skyGlowX·skyGlowY)
//          + 저해상도 구름 noise → full-res bilinear 업샘플(cloudFull).
// updateSky: 고도(deg)·cloudiness → skyRow/skyGlow*. updateCloudMask: 30초 게임시간마다 재계산.
import { SCR_W, SCR_H } from './config';
import { camera, sun, weather, timeRef } from './state';

export const SKY_DAY_Z   = [ 60,  90, 170], SKY_DAY_H   = [160, 185, 210];
export const SKY_DUSK_Z  = [ 42,  24,  64], SKY_DUSK_H  = [255, 144,  80];
export const SKY_NIGHT_Z = [  6,   8,  28], SKY_NIGHT_H = [ 12,  16,  40];

export const skyRow = new Uint32Array(SCR_H);
export const skyGlowX = new Float32Array(SCR_W);
export const skyGlowY = new Float32Array(SCR_H);
export const skyGlow = { r: 0, g: 0, b: 0 };

export const PX_PER_RAD_H_INIT = SCR_W / (Math.PI / 2);

export function updateSky(altDeg, cloudiness) {
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
    var cGray = 40 + 160 * dayW + 80 * duskW;
    var cGrayG = 45 + 160 * dayW + 70 * duskW;
    var cGrayB = 55 + 155 * dayW + 60 * duskW;
    var cdZ = cloudiness * 0.55;
    var cdH = cloudiness * 0.35;
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
    var glowStrength = 0;
    if (altDeg < 15 && altDeg > -8) {
        var k = 1 - Math.abs(altDeg - 3) / 12;
        if (k < 0) k = 0; else if (k > 1) k = 1;
        glowStrength = k * (1 - cloudiness * 0.5);
    }
    var glowMix = (altDeg + 8) / 23;
    if (glowMix < 0) glowMix = 0; else if (glowMix > 1) glowMix = 1;
    skyGlow.r = 255;
    skyGlow.g = (90 + 120 * glowMix) | 0;
    skyGlow.b = ( 50 +  90 * glowMix) | 0;

    var horizonY = (camera && camera.horizon) ? camera.horizon : (SCR_H * 0.5) | 0;
    for (var gy = 0; gy < SCR_H; gy++) {
        var dyH = gy - horizonY;
        var w;
        if (dyH <= 0) {
            var t2 = -dyH / 60;
            w = t2 < 1 ? (1 - t2) : 0;
        } else {
            w = 0;
        }
        skyGlowY[gy] = w * glowStrength;
    }

    var sunDelta = 0;
    if ((window as any).sun && (window as any).camera) {
        var d = sun.azRad + camera.angle;
        sunDelta = ((d + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
    }
    for (var gx = 0; gx < SCR_W; gx++) {
        var relAz = (gx - SCR_W / 2) / PX_PER_RAD_H_INIT;
        var ang = relAz - sunDelta;
        var ca = Math.cos(ang);
        skyGlowX[gx] = ca > 0 ? ca * ca : 0;
    }
}

// --- 구름 마스크 ---
const CLOUD_W = 64, CLOUD_H = 18;
const cloudMask = new Float32Array(CLOUD_W * CLOUD_H);
export const CLOUD_FULL_H = 200;
export const cloudFull = new Uint8ClampedArray(SCR_W * CLOUD_FULL_H);
var cloudLastKey = -1;

function cloudHash(ix, iy) {
    var h = ((ix | 0) * 374761393 ^ (iy | 0) * 668265263) >>> 0;
    h = (h ^ (h >>> 13)) * 1274126177 >>> 0;
    return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}
function cloudNoise2D(x, y) {
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

export function updateCloudMask() {
    var key = (timeRef.gameTime / 30000) | 0;
    if (key === cloudLastKey) return;
    cloudLastKey = key;
    var cloudi = weather.cloudiness;
    var panX = sun.lon * 0.4 + key * 0.05;
    var panY = sun.lat * 0.3;
    var thr = 1.1 - cloudi * 0.95;
    for (var cy = 0; cy < CLOUD_H; cy++) {
        for (var cx = 0; cx < CLOUD_W; cx++) {
            var u = (cx / CLOUD_W) * 8 + panX;
            var v = (cy / CLOUD_H) * 3 + panY;
            var n = cloudNoise2D(u, v) * 0.6 + cloudNoise2D(u * 2.1, v * 2.1) * 0.3 + cloudNoise2D(u * 4.3, v * 4.3) * 0.1;
            var m = n - thr;
            if (m < 0) m = 0;
            else if (m > 0.4) m = 0.4;
            cloudMask[cy * CLOUD_W + cx] = m * 2.5;
        }
    }
    for (var fy = 0; fy < CLOUD_FULL_H; fy++) {
        var v2 = (fy / CLOUD_FULL_H) * (CLOUD_H - 1);
        var vi = v2 | 0; var vf = v2 - vi;
        if (vi >= CLOUD_H - 1) { vi = CLOUD_H - 2; vf = 1; }
        for (var fx = 0; fx < SCR_W; fx++) {
            var u2 = (fx / SCR_W) * (CLOUD_W - 1);
            var ui = u2 | 0; var uf = u2 - ui;
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

export function cloudAlphaAt(x, y, horizonY) {
    if (y >= horizonY || y < 0 || x < 0 || x >= SCR_W) return 0;
    var fy = ((horizonY - y) / horizonY * (CLOUD_FULL_H - 1)) | 0;
    if (fy < 0) fy = 0; else if (fy >= CLOUD_FULL_H) fy = CLOUD_FULL_H - 1;
    return cloudFull[fy * SCR_W + x] / 255;
}

updateSky(45, 0.3);
