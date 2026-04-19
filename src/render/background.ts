// background.ts — 수평선 위 전부: sky glow · 구름 · 은하수 · 별 · 행성 · 달 · 태양 halo.
// Render() 보다 먼저 호출 → voxel 이 덮어 그림.
import { SCR_W, SCR_H } from '../config';
import { buf32 } from '../canvas';
import { camera, sun, weather, moonState } from '../state';
import {
    updateSky, updateCloudMask,
    skyRow, skyGlowX, skyGlowY, skyGlow,
    cloudFull, CLOUD_FULL_H, cloudAlphaAt,
} from '../sky';
import { STARS, starState, MILKYWAY, milkyState, starTwinklePhase, starTwinkleFreq } from '../astronomy/stars';
import { PLANETS, planetState } from '../astronomy/planets';
import { PX_PER_RAD_H } from './voxel';

export function DrawBackground() {
    updateSky(sun.altDeg, weather.cloudiness);
    updateCloudMask();
    // 구름 색: 낮=흰, 밤=어두운 회색, 황혼=주황
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

    // --- Milky Way band (별보다 뒤) ---
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
                var mCov = cloudAlphaAt(mxp, myp, horizonY);
                if (mCov > 0.5) continue;
                var mwa = mwDark * MILKYWAY[mj].dens * 0.35 * (1 - mCov);
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

    // --- Stars ---
    if (sun.altDeg < 0) {
        var darkness = (-sun.altDeg) / 12;
        if (darkness > 1) darkness = 1;
        darkness *= (1 - weather.cloudiness * 0.8);

        var twT = (typeof performance !== 'undefined' ? performance.now() : Date.now()) * 0.001;
        for (var si = 0; si < STARS.length; si++) {
            var star = STARS[si];
            var st = starState[si];
            if (st.altRad < 0) continue;
            var dlt = st.azRad + camera.angle;
            dlt = ((dlt + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
            if (Math.abs(dlt) > Math.PI / 2) continue;
            var sxs = (SCR_W / 2 + dlt * PX_PER_RAD_H) | 0;
            var sys = (camera.horizon - st.altRad * (camera.horizon / (Math.PI / 2))) | 0;
            if (sxs < 0 || sxs >= SCR_W || sys < 0 || sys >= SCR_H) continue;
            var sCov = cloudAlphaAt(sxs, sys, horizonY);
            if (sCov > 0.55) continue;
            var magBright = (4.0 - star.mag) / 3.5;
            if (magBright < 0.3) magBright = 0.3;
            else if (magBright > 1.2) magBright = 1.2;
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
            if (alpha > 0.5 && sxs >= 0 && sxs < SCR_W && sys >= 0 && sys < SCR_H) {
                buf32[sys * SCR_W + sxs] = 0xFFFAFAFF;
            } else {
                blendPx(sxs, sys, alpha);
            }
            blendPx(sxs + 1, sys,     alpha * 0.75);
            blendPx(sxs,     sys + 1, alpha * 0.75);
            blendPx(sxs + 1, sys + 1, alpha * 0.55);
            if (star.mag < 1.0) {
                blendPx(sxs - 1, sys,     alpha * 0.6);
                blendPx(sxs + 2, sys,     alpha * 0.5);
                blendPx(sxs,     sys - 1, alpha * 0.6);
                blendPx(sxs,     sys + 2, alpha * 0.5);
            }
            if (star.mag < 0.0) {
                blendPx(sxs - 1, sys - 1, alpha * 0.4);
                blendPx(sxs + 2, sys + 2, alpha * 0.4);
                blendPx(sxs + 2, sys - 1, alpha * 0.4);
                blendPx(sxs - 1, sys + 2, alpha * 0.4);
            }
        }
    }

    // --- Planets ---
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
            if (pmag > 6) continue;
            var pCov = cloudAlphaAt(ppx, ppy, camera.horizon);
            if (pCov > 0.55) continue;
            var c = PLANETS[pi].color;
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

    // --- Moon ---
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
            var bright = 0xFFE8F0F4;
            var isDay = sun.altDeg > 0;
            if (moonCov > 0.8) { /* 두꺼운 구름 뒤 */ } else {
            if (weather.cloudiness > 0.3 && ill > 0.1) {
                var MHR = 16 + (weather.cloudiness * 10) | 0;
                var MHR2 = MHR * MHR;
                var haloStrength = (weather.cloudiness - 0.3) * 0.7 * ill;
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
                        var idx = lym * SCR_W + lxm;
                        var bg = buf32[idx];
                        var bR = bg & 0xFF, bG = (bg >> 8) & 0xFF, bB = (bg >> 16) & 0xFF;
                        var a = 0.4;
                        var nR = (bR + (64 - bR) * a) | 0;
                        var nG = (bG + (72 - bG) * a) | 0;
                        var nB = (bB + (84 - bB) * a) | 0;
                        buf32[idx] = 0xFF000000 | (nB << 16) | (nG << 8) | nR;
                    }
                }
            }
            }
        }
    }

    // --- Sun disk + halo ---
    // delta = sunAz - cam_heading = sunAz + camera.angle
    var delta = sun.azRad + camera.angle;
    delta = ((delta + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
    if (sun.altDeg > -2 && Math.abs(delta) < Math.PI / 2) {
        var sxC = (SCR_W / 2 + delta * PX_PER_RAD_H) | 0;
        var syC = (camera.horizon - sun.altRad * (camera.horizon / (Math.PI / 2))) | 0;
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
        // Halo: alt↑ 반경 축소, alt↓ 반경+붉은기↑. cloudiness↑ 산란 더 많음.
        var haloBase;
        if (sun.altDeg >= 30) haloBase = 140;
        else if (sun.altDeg >= 0) haloBase = 140 + (30 - sun.altDeg) * (160 / 30);
        else haloBase = 300 + (-sun.altDeg) * 10;
        if (haloBase > 380) haloBase = 380;
        var HR = (haloBase * (1 + weather.cloudiness * 0.25)) | 0;
        var HR2 = HR * HR;
        var altT = sun.altDeg / 30;
        if (altT < 0) altT = 0; else if (altT > 1) altT = 1;
        var hR_ = (255) | 0;
        var hG_ = (100 + 140 * altT) | 0;
        var hB_ = ( 70 + 140 * altT) | 0;
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
