// camera.ts — 배 이동 + 카메라 snap + 물리/태양/날씨 매 프레임 갱신.
// UpdateCamera 가 게임 시간 진행(gameTime) 및 보트 이동을 모두 담당.
// moveBoat: 3x3 shore buffer + 서브스텝 분할 (큰 step에서 중간 셀 누락 방지).
import { MASK, SHIFT, SEA, WORLD_W, WORLD_H } from '../config';
import {
    boat, ship, camera, current,
    timeRef, frameStats, uiFlags,
    BASE_CAM_METERS, CAM_HEIGHT_MARGIN,
} from '../state';
import { heightMeters } from '../terrain';
import { altitude, ensureTilesLoaded } from '../tiles';
import { computeWind } from '../physics/wind';
import { computeSail, updateShipSpeed } from '../physics/sail';
import { computeCurrent } from '../physics/current';
import { computeWaves } from '../physics/waves';
import { computeWeather } from '../physics/weather';
import { computeSun } from '../astronomy/sun';
import { updateStars } from '../astronomy/stars';

export function moveBoat(dx, dy) {
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

export function UpdateCamera() {
    var nowMs = new Date().getTime();
    var dtMs = nowMs - frameStats.lastMoveTime;

    if (!uiFlags.skyMapOn) timeRef.gameTime += dtMs * timeRef.TIME_SPEED;

    camera.x = boat.gx;
    camera.y = boat.gy;
    camera.angle = boat.angle;

    computeSun();
    computeWind();
    computeSail();
    computeCurrent();
    updateShipSpeed();
    computeWaves();
    updateStars();
    computeWeather();

    // 이동: UNIT_M = 400 m/unit → units = m/s × gameSeconds / 400
    var gameDt = uiFlags.skyMapOn ? 0 : (dtMs * timeRef.TIME_SPEED) / 1000;
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

    var camoff = ((Math.floor(camera.y) & MASK) << SHIFT) + (Math.floor(camera.x) & MASK) | 0;
    var terAtCamM = heightMeters[altitude[camoff]];
    camera.heightMeters = Math.max(BASE_CAM_METERS, terAtCamM + CAM_HEIGHT_MARGIN);

    ensureTilesLoaded();

    frameStats.lastMoveTime = nowMs;
}
