// weather3d.ts — 배 뷰모델 씬(미터 단위, 배 좌표계)의 비·눈 파티클.
// 2D drawPrecipitation 은 화면 공간 점이라 3D 원근이 없다 — 여기선 카메라 주변 상자 안에서 실제로 떨어지고
// 바람에 밀리며, 배가 나아가면 뒤로 흐른다. 비는 속도 방향 짧은 선(모션 블러), 눈은 점.
// 빗방울이 수면에 닿으면 작은 물튐(boat-water.ts 파티클).
import * as THREE from 'three';
import { weather, wind, boat } from '../state';
import { FRAME_DT, seaHeight, spawnFoam } from './boat-water';

const RAIN_MAX = 1400, SNOW_MAX = 1600;
const BX = 26, BZ0 = -34, BZ1 = 13, BY = 20;   // 상자: x ±BX, z BZ0~BZ1 (카메라 z≈19 — 6m 이내는 거대 입자라 제외), 높이 0~BY
const RAIN_FALL = 9, SNOW_FALL = 1.2;           // m/s
const STREAK = 0.09;                            // 빗줄기 길이 = 속도 × STREAK 초

const rainPos = new Float32Array(RAIN_MAX * 3);  // 빗방울 머리 위치
const rainSeg = new Float32Array(RAIN_MAX * 6);  // 선분 (꼬리, 머리)
const snowPos = new Float32Array(SNOW_MAX * 3);
const snowPh = new Float32Array(SNOW_MAX);       // 눈송이 흔들림 위상
let rainLines: THREE.LineSegments;
let snowPts: THREE.Points;

function respawn(arr: Float32Array, i: number, top: boolean) {
    arr[i * 3] = (Math.random() * 2 - 1) * BX;
    arr[i * 3 + 1] = top ? BY * (0.8 + Math.random() * 0.2) : Math.random() * BY;
    arr[i * 3 + 2] = BZ0 + Math.random() * (BZ1 - BZ0);
}

export function buildWeather3D(scene: THREE.Scene) {
    for (var i = 0; i < RAIN_MAX; i++) respawn(rainPos, i, false);
    for (var j = 0; j < SNOW_MAX; j++) { respawn(snowPos, j, false); snowPh[j] = Math.random() * 6.28; }
    var rg = new THREE.BufferGeometry();
    rg.setAttribute('position', new THREE.BufferAttribute(rainSeg, 3));
    rainLines = new THREE.LineSegments(rg, new THREE.LineBasicMaterial({
        color: 0xb8c8d8, transparent: true, opacity: 0.45, depthWrite: false,
    }));
    var sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.BufferAttribute(snowPos, 3));
    snowPts = new THREE.Points(sg, new THREE.PointsMaterial({
        color: 0xf4f6ff, size: 0.11, sizeAttenuation: true, transparent: true, opacity: 0.9, depthWrite: false,
    }));
    rainLines.frustumCulled = snowPts.frustumCulled = false;
    rainLines.renderOrder = snowPts.renderOrder = 3;
    rainLines.visible = snowPts.visible = false;
    scene.add(rainLines, snowPts);
}

function wrap(arr: Float32Array, i: number) {
    var j = i * 3;
    if (arr[j] < -BX) arr[j] += 2 * BX; else if (arr[j] > BX) arr[j] -= 2 * BX;
    if (arr[j + 2] < BZ0) arr[j + 2] += BZ1 - BZ0; else if (arr[j + 2] > BZ1) arr[j + 2] -= BZ1 - BZ0;
}

// speedMS: 대수속력(배가 앞으로 가면 입자는 상대적으로 뒤(+z)로)
export function updateWeather3D(speedMS: number) {
    var intensity = weather.precipitation;
    var snow = weather.precipType === 'snow';
    rainLines.visible = intensity > 0.001 && !snow;
    snowPts.visible = intensity > 0.001 && snow;
    if (intensity <= 0.001) return;

    // 바람이 불어가는 방향을 배 좌표로: 불어오는 쪽(월드 동·남) → 우현/선미 성분, 부호 반전
    var fx = Math.sin(wind.angleRad), fy = -Math.cos(wind.angleRad);
    var ca = Math.cos(boat.angle), sa = Math.sin(boat.angle);
    var wxB = -(fx * ca - fy * sa);        // 우현 = (cos a, -sin a)
    var wzB = -(fx * sa + fy * ca);        // 선미 = (sin a, cos a)
    var dt = FRAME_DT;

    if (!snow) {
        var n = (RAIN_MAX * intensity) | 0, drift = wind.speedMS * 0.6;
        var vx = wxB * drift, vz = wzB * drift + speedMS, vy = -RAIN_FALL;
        var splashes = 0;
        for (var i = 0; i < RAIN_MAX; i++) {
            var j = i * 3, k = i * 6;
            if (i >= n) { rainSeg[k + 1] = rainSeg[k + 4] = -999; continue; } // 비활성: 화면 밖
            rainPos[j] += vx * dt; rainPos[j + 1] += vy * dt; rainPos[j + 2] += vz * dt;
            wrap(rainPos, i);
            var sea = seaHeight(rainPos[j], rainPos[j + 2]);
            if (rainPos[j + 1] < sea) {
                if (splashes < 3 && rainPos[j + 2] > -12 && Math.random() < 0.3) {
                    spawnFoam(rainPos[j], sea + 0.03, rainPos[j + 2], 0, 0.8, 0, 0.25, false);
                    splashes++;
                }
                respawn(rainPos, i, true);
            }
            rainSeg[k] = rainPos[j] - vx * STREAK; rainSeg[k + 1] = rainPos[j + 1] - vy * STREAK; rainSeg[k + 2] = rainPos[j + 2] - vz * STREAK;
            rainSeg[k + 3] = rainPos[j]; rainSeg[k + 4] = rainPos[j + 1]; rainSeg[k + 5] = rainPos[j + 2];
        }
        rainLines.geometry.attributes.position.needsUpdate = true;
    } else {
        var m = (SNOW_MAX * intensity) | 0, sdrift = wind.speedMS * 0.8;
        for (var q = 0; q < SNOW_MAX; q++) {
            var p = q * 3;
            if (q >= m) { snowPos[p + 1] = -999; continue; }
            if (snowPos[p + 1] < -900) respawn(snowPos, q, true);
            snowPh[q] += dt * 1.7;
            snowPos[p] += (wxB * sdrift + Math.sin(snowPh[q]) * 0.4) * dt;
            snowPos[p + 1] -= SNOW_FALL * dt;
            snowPos[p + 2] += (wzB * sdrift + speedMS + Math.cos(snowPh[q] * 0.7) * 0.4) * dt;
            wrap(snowPos, q);
            if (snowPos[p + 1] < seaHeight(snowPos[p], snowPos[p + 2])) respawn(snowPos, q, true);
        }
        snowPts.geometry.attributes.position.needsUpdate = true;
    }
}
