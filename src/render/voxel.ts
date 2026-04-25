// voxel.ts — Voxel Space bilinear 4-이웃 샘플링 + 곡률 + 파도 색 변조 + 거리별 fog.
// HOT PATH: 프레임 대부분 여기서 소요. state 싱글톤은 함수 진입 시 local 캐싱 패턴 유지.
// hiddeny: 함수 밖에 한 번만 할당 → GC 부담 제거.
// allSea fast path: 4 이웃 SEA면 bilinear 스킵, 상수 사용.
// early termination: hiddeny[i]<=0 컬럼 skip + openCount==0 시 z 루프 break.
import {
    SCR_W, SCR_H, SEA, SHIFT, MASK,
    RENDER_CURVATURE_COEFF, RENDER_PROJ_SCALE,
    RENDER_DELTAZ_INIT, RENDER_DELTAZ_STEP, RENDER_WAVE_COLOR_GAIN,
} from '../config';
import { buf32 } from '../canvas';
import { camera, wave, weather } from '../state';
import { heightMeters } from '../terrain';
import { altitude, colormap } from '../tiles';

// Fog target: 바다 → 하늘색, 육지 → 어두운 회색
export const FOG_SEA_R = 160, FOG_SEA_G = 185, FOG_SEA_B = 210;
export const FOG_LAND_R = 90,  FOG_LAND_G = 100, FOG_LAND_B = 120;

// 수평 FOV 90° ⇒ 45° = 화면 절반(±320px). 수직 alt=0° → horizon, alt=90° → 화면 상단.
export const PX_PER_RAD_H = SCR_W / (Math.PI / 2);

export function DrawVerticalLine(x, ytop, ybottom, col) {
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

export const hiddeny = new Int32Array(SCR_W);

export function Render() {
    var sinang = Math.sin(camera.angle);
    var cosang = Math.cos(camera.angle);

    hiddeny.fill(SCR_H);
    var openCount = SCR_W;

    var deltaz = RENDER_DELTAZ_INIT;
    var camMeters = camera.heightMeters;

    var CURVATURE_COEFF = RENDER_CURVATURE_COEFF;
    var HEIGHT_SEA = heightMeters[SEA];

    var dist = camera.distance;
    var dist_wave_3 = dist * 0.2;
    var dist_wave_2 = dist * 0.5;
    var dist_wave_1 = dist * 0.7;

    var wt  = wave.time;
    var wsdx = wave.swell.dx,  wsdy = wave.swell.dy,  wss = wave.swell.speed,  wsa = wave.swell.amp;
    var wmdx = wave.mid.dx,    wmdy = wave.mid.dy,    wms = wave.mid.speed,    wma = wave.mid.amp;
    var wrdx = wave.ripple.dx, wrdy = wave.ripple.dy, wrs = wave.ripple.speed, wra = wave.ripple.amp;

    var visDist = dist * weather.visibilityCoef;
    var horizon = camera.horizon;
    var camX = camera.x, camY = camera.y;

    for (var z = 1; z < dist; z += deltaz) {
        var curvatureDrop = z * z * CURVATURE_COEFF;
        var plx =  -cosang * z - sinang * z;
        var ply =   sinang * z - cosang * z;
        var prx =   cosang * z - sinang * z;
        var pry =  -sinang * z - cosang * z;

        var dx = (prx - plx) / SCR_W;
        var dy = (pry - ply) / SCR_W;
        plx += camX;
        ply += camY;
        var projScale = (SCR_H * RENDER_PROJ_SCALE) / z;

        var fog = Math.pow(z / visDist, 1.2);
        if (fog > 1) fog = 1;
        var mf = 1.0 - fog;

        var waveStage = z < dist_wave_3 ? 3 : z < dist_wave_2 ? 2 : z < dist_wave_1 ? 1 : 0;

        var seaTerM = HEIGHT_SEA - curvatureDrop;
        var seaHos  = (camMeters - seaTerM) * projScale + horizon | 0;

        for (var i = 0; i < SCR_W | 0; i = i + 1 | 0) {
            var prevH = hiddeny[i];
            if (prevH <= 0) {
                plx += dx;
                ply += dy;
                continue;
            }

            var px_i = plx | 0, py_i = ply | 0;
            var ix0 = px_i & MASK, iy0 = py_i & MASK;
            var ix1 = (ix0 + 1) & MASK, iy1 = (iy0 + 1) & MASK;
            var off00 = (iy0 << SHIFT) + ix0 | 0;

            var a00 = altitude[off00];

            var heightonscreen, cR, cG, cB, isSea;

            var off10 = (iy0 << SHIFT) + ix1 | 0;
            var off01 = (iy1 << SHIFT) + ix0 | 0;
            var off11 = (iy1 << SHIFT) + ix1 | 0;
            var a10 = altitude[off10], a01 = altitude[off01], a11 = altitude[off11];
            var allSea = (a00 <= SEA) & (a10 <= SEA) & (a01 <= SEA) & (a11 <= SEA);
            isSea = allSea !== 0;

            if (isSea) {
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

                var terMeters = heightMeters[a00] * w00 + heightMeters[a10] * w10
                              + heightMeters[a01] * w01 + heightMeters[a11] * w11;
                terMeters -= curvatureDrop;
                heightonscreen = (camMeters - terMeters) * projScale + horizon | 0;
                if (heightonscreen >= prevH) {
                    plx += dx;
                    ply += dy;
                    continue;
                }

                var c00 = colormap[off00], c10v = colormap[off10];
                var c01v = colormap[off01], c11v = colormap[off11];
                cR = (c00 & 0xFF) * w00 + (c10v & 0xFF) * w10
                   + (c01v & 0xFF) * w01 + (c11v & 0xFF) * w11;
                cG = ((c00 >> 8) & 0xFF) * w00 + ((c10v >> 8) & 0xFF) * w10
                   + ((c01v >> 8) & 0xFF) * w01 + ((c11v >> 8) & 0xFF) * w11;
                cB = ((c00 >> 16) & 0xFF) * w00 + ((c10v >> 16) & 0xFF) * w10
                   + ((c01v >> 16) & 0xFF) * w01 + ((c11v >> 16) & 0xFF) * w11;
            }

            // 파도 sin 좌표는 카메라 상대값 — 큰 월드 좌표에 파벡터 곱하면 위상 점프 → 깜박임.
            if (isSea && waveStage > 0) {
                var wx = plx - camX, wy = ply - camY;
                var waveVal = Math.sin(wx * wsdx + wy * wsdy + wt * wss) * wsa;
                if (waveStage >= 2) waveVal += Math.sin(wx * wmdx + wy * wmdy + wt * wms) * wma;
                if (waveStage >= 3) waveVal += Math.sin(wx * wrdx + wy * wrdy + wt * wrs) * wra;
                var wc = waveVal * RENDER_WAVE_COLOR_GAIN;
                cR += wc; cG += wc; cB += wc * 0.5;
            }

            var c = 0xFF000000
                  | ((cB < 0 ? 0 : cB > 255 ? 255 : cB | 0) << 16)
                  | ((cG < 0 ? 0 : cG > 255 ? 255 : cG | 0) << 8)
                  |  (cR < 0 ? 0 : cR > 255 ? 255 : cR | 0);

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
            if (heightonscreen <= 0 && prevH > 0) openCount--;

            plx += dx;
            ply += dy;
        }
        deltaz += RENDER_DELTAZ_STEP;

        if (openCount <= 0) break;
    }
}
