// camera.ts — 배 이동 + 카메라 snap + 물리/태양/날씨 매 프레임 갱신.
// UpdateCamera 가 게임 시간 진행(gameTime) 및 보트 이동을 모두 담당.
// moveBoat: 3x3 shore buffer + 서브스텝 분할 (큰 step에서 중간 셀 누락 방지) + 해안 미끄러짐.
import { MASK, SHIFT, SEA, WORLD_W, WORLD_H } from '../config';
import {
    boat, ship, camera, current,
    timeRef, frameStats, uiFlags,
    BASE_CAM_METERS, CAM_HEIGHT_MARGIN, RUDDER_POWER, RUDDER_TAU,
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

// (nx, ny) 가 속한 셀의 3x3 이웃 중 육지가 있으면 true
function shoreBlocked(nx: number, ny: number): boolean {
    var cx = Math.floor(nx), cy = Math.floor(ny);
    for (var oy = -1; oy <= 1; oy++) {
        for (var ox = -1; ox <= 1; ox++) {
            var off = (((cy + oy) & MASK) << SHIFT) + ((cx + ox) & MASK) | 0;
            if (altitude[off] > SEA) return true;
        }
    }
    return false;
}

// 반환: 요청 이동 방향으로 실제 나아간 비율 (0~1). 해안에 막히면 축 성분으로 미끄러진다 —
// 비스듬히 닿으면 해안을 따라 흘러가고, 정면으로 들이받으면 멈춘다.
export function moveBoat(dx, dy): number {
    var mvLen = Math.hypot(dx, dy);
    if (mvLen === 0) return 1;
    var SUBSTEPS = Math.max(1, Math.ceil(mvLen * 4));
    var sx = dx / SUBSTEPS, sy = dy / SUBSTEPS;
    var mx = 0, my = 0;   // 실제 이동량 (wrap 전)
    for (var si = 0; si < SUBSTEPS; si++) {
        var ax = sx, ay = sy;
        if (shoreBlocked(boat.gx + ax, boat.gy + ay)) {
            if (Math.abs(sx) >= Math.abs(sy)) {
                if (!shoreBlocked(boat.gx + sx, boat.gy)) ay = 0;
                else if (!shoreBlocked(boat.gx, boat.gy + sy)) ax = 0;
                else break;
            } else {
                if (!shoreBlocked(boat.gx, boat.gy + sy)) ax = 0;
                else if (!shoreBlocked(boat.gx + sx, boat.gy)) ay = 0;
                else break;
            }
        }
        var nx = boat.gx + ax, ny = boat.gy + ay;
        mx += ax; my += ay;
        nx = ((nx % WORLD_W) + WORLD_W) % WORLD_W;
        if (ny < 0) ny = 0;
        else if (ny > WORLD_H - 1) ny = WORLD_H - 1;
        boat.gx = nx;
        boat.gy = ny;
    }
    var f = (mx * dx + my * dy) / (mvLen * mvLen);
    return f < 0 ? 0 : f > 1 ? 1 : f;
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
        // 러더 유체역학 (1차 응답, exact exponential):
        //   목표 yaw = rudder × waterMS × POWER (rad / game-sec). waterMS 는 돛+노 대수속력 — 해류
        //   drift 는 물과 함께 움직이므로 러더 효과에 기여 안 함.
        //   yawRate 는 τ=RUDDER_TAU 로 목표에 지수 감쇠 수렴 — 키 꺾어도 즉시 회전 점프 안 함.
        //   rudder=+1(우) → yaw > 0 → angle 감소 (convention: 0=북, π/2=서, 증가=반시계 — 우현 선회 = 감소).
        var targetYaw = boat.rudder * ship.waterMS * RUDDER_POWER;
        var decay = Math.exp(-gameDt / RUDDER_TAU);
        boat.yawRate = targetYaw + (boat.yawRate - targetYaw) * decay;
        boat.angle -= boat.yawRate * gameDt;
        var gx0 = boat.gx, gy0 = boat.gy;
        if (ship.waterMS > 0.01) {
            var sU = ship.waterMS * gameDt / 400;
            // 해안에 막혀 못 나아간 만큼 대수속력도 줄인다 — 멈춘 배에서 항적·물결이 계속 흐르지 않게.
            // (러더 yaw 는 위에서 막히기 전 속력으로 이미 계산 → 막혀도 뱃머리를 돌려 빠져나올 수 있다)
            ship.waterMS *= moveBoat(-Math.sin(boat.angle) * sU, -Math.cos(boat.angle) * sU);
        }
        if (current.speedMS > 0.01) {
            var cU = current.speedMS * gameDt / 400;
            moveBoat(
                 Math.sin(current.angleRad) * cU,
                -Math.cos(current.angleRad) * cU
            );
        }
        // 대지속력 = 실제 이동량 (해안 미끄러짐·정지 반영)
        var mdx = boat.gx - gx0, mdy = boat.gy - gy0;
        if (mdx > WORLD_W / 2) mdx -= WORLD_W; else if (mdx < -WORLD_W / 2) mdx += WORLD_W;
        ship.groundMS = Math.hypot(mdx, mdy) * 400 / gameDt;
        if (ship.groundMS > 1e-4) {
            ship.groundDirRad = Math.atan2(mdx, -mdy);
            if (ship.groundDirRad < 0) ship.groundDirRad += 2 * Math.PI;
        }
    }

    var camoff = ((Math.floor(camera.y) & MASK) << SHIFT) + (Math.floor(camera.x) & MASK) | 0;
    var terAtCamM = heightMeters[altitude[camoff]];
    camera.heightMeters = Math.max(BASE_CAM_METERS, terAtCamM + CAM_HEIGHT_MARGIN);

    ensureTilesLoaded();

    frameStats.lastMoveTime = nowMs;
}
