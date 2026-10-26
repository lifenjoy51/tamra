// camera.ts — 배 이동 + 카메라 snap + 물리/태양/날씨 매 프레임 갱신.
// UpdateCamera 가 게임 시간 진행(gameTime) 및 보트 이동을 모두 담당.
// moveBoat: 연속 해안선(coast.ts) 충돌 + 서브스텝 분할 (큰 step에서 해안 통과 방지) + 해안 미끄러짐.
import { WORLD_W, WORLD_H } from '../config';
import {
    boat, ship, camera, current,
    timeRef, frameStats, uiFlags,
    BASE_CAM_METERS, CAM_HEIGHT_MARGIN, RUDDER_POWER, RUDDER_TAU,
} from '../state';
import { ensureTilesLoaded } from '../tiles';
import { coastL, terrainHeightM, nearLandM } from '../coast';
import { computeWind } from '../physics/wind';
import { computeSail, updateShipSpeed } from '../physics/sail';
import { computeCurrent } from '../physics/current';
import { computeWaves } from '../physics/waves';
import { computeWeather } from '../physics/weather';
import { computeSun } from '../astronomy/sun';
import { updateStars } from '../astronomy/stars';

// 배 중심이 해안선(L=0) 바깥 L < -SHORE_L 이어야 항해 가능 — 해안 기울기 ~2/셀 기준 ≈ 20m
// (선체 반 길이 6.5m + 여유).
const SHORE_L = 0.1;
const GRAD_EPS = 0.01;   // 해안 법선 차분 간격 (셀, 4m)
// 해안 근처 이동 배속: k = 육지까지 거리 / NEAR_REF_M (1 ~ TIME_SPEED). 가까운 해안의 각속도(시차)를
// 실제 항해 수준으로 묶는다 — 120배속 그대로면 20m 옆 절벽이 초속 수백 m 로 스쳐 지나가고,
// 배 주변 물결·항적(실시간 속도)과 어긋난다. 먼바다(6km+)는 그대로 TIME_SPEED.
const NEAR_REF_M = 40;

function shoreBlocked(nx: number, ny: number): boolean {
    return coastL(nx, ny) > -SHORE_L;
}

// 반환: 요청 이동 방향으로 실제 나아간 비율 (0~1). 해안에 막히면 해안선 접선 방향 성분으로
// 미끄러진다 — 비스듬히 닿으면 해안을 따라 흘러가고, 정면으로 들이받으면 멈춘다.
export function moveBoat(dx, dy): number {
    var mvLen = Math.hypot(dx, dy);
    if (mvLen === 0) return 1;
    var SUBSTEPS = Math.max(1, Math.ceil(mvLen * 40));   // 서브스텝 ≤ 10m — 해안 근접 정지 위치 오차
    var sx = dx / SUBSTEPS, sy = dy / SUBSTEPS;
    var mx = 0, my = 0;   // 실제 이동량 (wrap 전)
    for (var si = 0; si < SUBSTEPS; si++) {
        var ax = sx, ay = sy;
        if (shoreBlocked(boat.gx + ax, boat.gy + ay)) {
            // 육지 쪽 법선 = ∇L. 그 성분을 빼서 접선으로.
            var gx = coastL(boat.gx + GRAD_EPS, boat.gy) - coastL(boat.gx - GRAD_EPS, boat.gy);
            var gy = coastL(boat.gx, boat.gy + GRAD_EPS) - coastL(boat.gx, boat.gy - GRAD_EPS);
            var gl = Math.hypot(gx, gy);
            if (gl < 1e-9) break;
            var grad = gl / (2 * GRAD_EPS);   // L 기울기 (/셀)
            gx /= gl; gy /= gl;
            var into = ax * gx + ay * gy;
            if (into > 0) { ax -= into * gx; ay -= into * gy; }
            // 거의 정면이면 미끄러지지 않고 멈춘다 (작은 접선 이동 ↔ 해류 되밀림이 번갈아 떨리던 문제)
            if (Math.hypot(ax, ay) < 0.25 * Math.hypot(sx, sy)) break;
            // 볼록한 해안에선 접선으로 가도 L 이 살짝 오른다 — 넘친 만큼 바다 쪽으로 되밀기
            var over = coastL(boat.gx + ax, boat.gy + ay) + SHORE_L;
            if (over > 0) {
                var push = over / Math.max(grad, 0.5) + 1e-4;
                if (push > Math.hypot(sx, sy)) break;   // 서브스텝보다 크게 밀어야 하면 오목한 구석 — 정지
                ax -= gx * push; ay -= gy * push;
            }
            if (shoreBlocked(boat.gx + ax, boat.gy + ay)) break;
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
    updateStars();      // 달 시간각 → 조류 위상 (computeCurrent 전에)
    computeWind();
    computeSail();
    computeCurrent();
    updateShipSpeed();
    computeWaves();
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
        ship.nearLandM = nearLandM(boat.gx, boat.gy);
        var kTarget = Math.max(1, Math.min(timeRef.TIME_SPEED, ship.nearLandM / NEAR_REF_M));
        // 가까워질 땐 즉시, 멀어질 땐 서서히 (해안을 벗어나자마자 튀어나가지 않게)
        ship.moveScale = kTarget < ship.moveScale ? kTarget : ship.moveScale + (kTarget - ship.moveScale) * 0.1;
        var moveDt = uiFlags.skyMapOn ? 0 : (dtMs * ship.moveScale) / 1000;
        if (ship.waterMS > 0.01) {
            var sU = ship.waterMS * moveDt / 400;
            // 해안에 막혀 못 나아간 만큼 대수속력도 줄인다 — 멈춘 배에서 항적·물결이 계속 흐르지 않게.
            // (러더 yaw 는 위에서 막히기 전 속력으로 이미 계산 → 막혀도 뱃머리를 돌려 빠져나올 수 있다)
            ship.waterMS *= moveBoat(-Math.sin(boat.angle) * sU, -Math.cos(boat.angle) * sU);
        }
        if (current.speedMS > 0.01) {
            var cU = current.speedMS * moveDt / 400;
            moveBoat(
                 Math.sin(current.angleRad) * cU,
                -Math.cos(current.angleRad) * cU
            );
        }
        // 대지속력 = 실제 이동량 (해안 미끄러짐·정지 반영)
        var mdx = boat.gx - gx0, mdy = boat.gy - gy0;
        if (mdx > WORLD_W / 2) mdx -= WORLD_W; else if (mdx < -WORLD_W / 2) mdx += WORLD_W;
        ship.groundMS = moveDt > 0 ? Math.hypot(mdx, mdy) * 400 / moveDt : 0;
        if (ship.groundMS > 1e-4) {
            ship.groundDirRad = Math.atan2(mdx, -mdy);
            if (ship.groundDirRad < 0) ship.groundDirRad += 2 * Math.PI;
        }
    }

    // 셀 꼭짓점 고도가 아니라 연속 지형 높이 — 해안 바로 앞에서 꼭짓점이 육지라도 눈높이가 튀지 않게.
    var terAtCamM = Math.max(0, terrainHeightM(camera.x, camera.y));
    camera.heightMeters = Math.max(BASE_CAM_METERS, terAtCamM + CAM_HEIGHT_MARGIN);

    ensureTilesLoaded();

    frameStats.lastMoveTime = nowMs;
}
