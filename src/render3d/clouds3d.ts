// clouds3d.ts — 3D 구름: 기상장(synoptic.skyAt)을 따라 흘러가는 구름층 + 낮에 섬 위에 서는 적운.
//
// 구름층: 상층풍(편서풍대 동쪽 ~35 km/h, 열대 서쪽)으로 흘러가는 격자(4 km) 칸마다, 그 자리 구름량만큼의
//   확률로 뭉게 하나. 저기압·장마 전선·태풍이 다가오면 수평선 쪽부터 구름 띠가 짙어진다. 별·해·달을 가린다.
// 지형 적운: 땅 위 격자(2.4 km)에 낮(9~18시) 동안 높이 비례로 선다. 섬 자체는 수평선 아래여도
//   구름은 1 km 넘게 떠 있어 100 km 밖에서도 보인다 — 옛 항해자의 대표적 "섬이 있다" 단서. 바람이 세면 흩어진다.
// 렌더: 빌보드 InstancedMesh 1개 (부드러운 뭉게 텍스처, 깊이 쓰기 없음, fog 로 먼 구름은 지평 안개에 묻힘).
import * as THREE from 'three';
import { sun, moonState, wind, weather, timeRef } from '../state';
import { skyAt, SkySample } from '../physics/synoptic';
import { terrainHeightM } from '../coast';
import { DEG_PER_PIXEL, ORIGIN_LAT, ORIGIN_LON, RENDER_UNIT_M } from '../config';
import { sceneOrigin, metersToSceneY } from './coords';

const MAX = 3200;
const SP = 10;              // 구름층 격자 (world px = 4 km)
const LSP = 6;              // 지형 적운 격자 (2.4 km)
const RAD = 230;            // 반경 (px ≈ 92 km)
const CURV_K = RENDER_UNIT_M / (2 * 6371000);
const REEVAL_H = 0.5;       // 칸 구름량 재평가 (게임 시간)
const EVALS_PER_FRAME = 160;

let mesh: THREE.InstancedMesh;
const sk: SkySample = { cloud: 0, precip: 0, fog: 0 };
const _m = new THREE.Matrix4(), _p = new THREE.Vector3(), _s = new THREE.Vector3(), _c = new THREE.Color();

function hash2(ix: number, iy: number, k: number): number {
    var h = Math.imul(ix | 0, 374761393) ^ Math.imul(iy | 0, 668265263) ^ Math.imul(k, 1103515245);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function ss(x: number): number {
    return x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x);
}

function puffTexture(): THREE.Texture {
    var c = document.createElement('canvas');
    c.width = 128; c.height = 64;
    var ctx = c.getContext('2d')!;
    // 밑이 평평하고 위가 봉긋한 뭉게: 부드러운 원 여러 개
    var blobs = [[64, 40, 26], [40, 44, 20], [88, 44, 20], [52, 30, 18], [78, 28, 17], [22, 48, 13], [106, 48, 13]];
    for (var i = 0; i < blobs.length; i++) {
        var b = blobs[i];
        var g = ctx.createRadialGradient(b[0], b[1], 0, b[0], b[1], b[2]);
        g.addColorStop(0, 'rgba(255,255,255,0.55)');
        g.addColorStop(0.6, 'rgba(255,255,255,0.35)');
        g.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, 128, 64);
    }
    // 밑면 자르기 (평평한 구름 밑)
    ctx.globalCompositeOperation = 'destination-out';
    var gb = ctx.createLinearGradient(0, 50, 0, 60);
    gb.addColorStop(0, 'rgba(0,0,0,0)');
    gb.addColorStop(1, 'rgba(0,0,0,1)');
    ctx.fillStyle = gb;
    ctx.fillRect(0, 50, 128, 14);
    var tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
}

export function buildClouds(scene: THREE.Scene) {
    var mat = new THREE.MeshBasicMaterial({ map: puffTexture(), transparent: true, depthWrite: false, fog: true });
    mesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), mat, MAX);
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX * 3), 3);
    mesh.frustumCulled = false;
    mesh.renderOrder = 1;   // 별·해·달(먼 투명 객체) 다음에 그려 가린다
    mesh.count = 0;
    scene.add(mesh);
}

// 칸 구름량 캐시 (키 = 칸 좌표)
interface Cell { cloud: number; t: number; }
const cells = new Map<number, Cell>();
const landH = new Map<number, number>();
let landAge = 0;

function key(ix: number, iy: number): number {
    return ix * 131071 + iy;
}

export function updateClouds(cam: THREE.Camera) {
    if (!mesh) return;
    var tH = timeRef.gameTime / 3.6e6;
    var camGx = cam.position.x + sceneOrigin.gx, camGy = cam.position.z + sceneOrigin.gy;
    var lat0 = ORIGIN_LAT - camGy * DEG_PER_PIXEL;
    // 상층풍 흐름 (px): 편서풍대 동쪽 35 km/h, 열대 서쪽 15 km/h
    var mid = ss((Math.abs(lat0) - 20) / 12);
    var kmPerPx = DEG_PER_PIXEL * 111.2 * Math.cos(lat0 * Math.PI / 180);
    var drift = (35 * mid - 15 * (1 - mid)) * tH / kmPerPx;

    // 하늘빛: 낮 밝기 + 노을 + 밤(달빛)
    var dayT = ss((sun.altDeg + 6) / 20);
    var warm = sun.altDeg > -4 ? 1 - ss(sun.altDeg / 15) : 0;
    var night = 0.06 + 0.1 * (moonState.altRad > 0 ? moonState.illumination : 0);
    var bright = night + (1 - night) * dayT;

    var n = 0, evals = 0;
    var q = cam.quaternion;
    // --- 구름층 (흘러가는 격자) ---
    var ix0 = Math.floor((camGx - drift - RAD) / SP), ix1 = Math.floor((camGx - drift + RAD) / SP);
    var iy0 = Math.floor((camGy - RAD) / SP), iy1 = Math.floor((camGy + RAD) / SP);
    for (var iy = iy0; iy <= iy1 && n < MAX; iy++) {
        for (var ix = ix0; ix <= ix1 && n < MAX; ix++) {
            var jx = hash2(ix, iy, 1), jy = hash2(ix, iy, 2), hr = hash2(ix, iy, 3);
            var gx = (ix + jx) * SP + drift, gy = (iy + jy) * SP;
            var dx = gx - camGx, dy = gy - camGy, d2 = dx * dx + dy * dy;
            if (d2 > RAD * RAD) continue;
            var k = key(ix, iy), c = cells.get(k);
            if (!c || Math.abs(tH - c.t) > REEVAL_H) {
                if (evals < EVALS_PER_FRAME || !c) {
                    skyAt(ORIGIN_LAT - gy * DEG_PER_PIXEL, ORIGIN_LON + gx * DEG_PER_PIXEL, tH, sk);
                    if (!c) { c = { cloud: sk.cloud, t: tH }; cells.set(k, c); } else { c.cloud = sk.cloud; c.t = tH; }
                    evals++;
                }
            }
            var cv = c.cloud;
            // 맑은 날에도 드문드문, 흐릴수록 촘촘·크게
            if (hr > cv * 1.15 - 0.05) continue;
            var size = (4 + 7 * cv + 3 * hash2(ix, iy, 4)) * 1000 / RENDER_UNIT_M;
            var altM = 1300 - 600 * cv + 500 * hash2(ix, iy, 5);   // 흐릴수록 낮은 구름
            _p.set(gx - sceneOrigin.gx, metersToSceneY(altM) - d2 * CURV_K, gy - sceneOrigin.gy);
            _s.set(size, size * 0.5, 1);
            _m.compose(_p, q, _s);
            mesh.setMatrixAt(n, _m);
            var shade = (1 - 0.55 * ss((cv - 0.5) / 0.4)) * bright;
            _c.setRGB(shade * (1 + 0.2 * warm), shade * (1 - 0.05 * warm), shade * (1 - 0.3 * warm));
            mesh.setColorAt(n, _c);
            n++;
        }
    }
    // 오래된 칸 정리
    if (cells.size > 20000) cells.clear();

    // --- 지형 적운 (땅에 고정, 낮에만) ---
    var hour = sun.hourLocal;
    var dayCu = ss((hour - 9) / 2) * (1 - ss((hour - 17) / 2)) * ss(sun.altDeg / 15) * (1 - ss((wind.speedMS - 10) / 6));
    if (++landAge > 600) { landH.clear(); landAge = 0; }   // 타일이 늦게 로드된 경우 갱신
    if (dayCu > 0.02) {
        var amt = dayCu * (0.55 + 0.45 * weather.cloudiness);
        var wE = Math.sin(wind.angleRad + Math.PI), wS = -Math.cos(wind.angleRad + Math.PI);  // 바람 불어가는 쪽 (월드 동·남)
        var lx0 = Math.floor((camGx - RAD) / LSP), lx1 = Math.floor((camGx + RAD) / LSP);
        var ly0 = Math.floor((camGy - RAD) / LSP), ly1 = Math.floor((camGy + RAD) / LSP);
        for (var ly = ly0; ly <= ly1 && n < MAX; ly++) {
            for (var lx = lx0; lx <= lx1 && n < MAX; lx++) {
                var cx = (lx + 0.5) * LSP, cy = (ly + 0.5) * LSP;
                var ddx = cx - camGx, ddy = cy - camGy, dd2 = ddx * ddx + ddy * ddy;
                if (dd2 > RAD * RAD) continue;
                var lk = key(lx, ly), h = landH.get(lk);
                if (h === undefined) { h = terrainHeightM(cx, cy); landH.set(lk, h); }
                if (h < 15) continue;
                var hh = hash2(lx, ly, 7);
                if (hh > amt * (0.35 + 0.65 * ss(h / 400))) continue;
                // 바람 불어가는 쪽으로 2~4 km 밀림
                var off = (2 + 2 * hash2(lx, ly, 8)) * 1000 / RENDER_UNIT_M;
                var px = cx + wE * off + (hash2(lx, ly, 9) - 0.5) * LSP, py = cy + wS * off + (hash2(lx, ly, 10) - 0.5) * LSP;
                var pdx = px - camGx, pdy = py - camGy, pd2 = pdx * pdx + pdy * pdy;
                var sz = (2.5 + 4 * ss(h / 800) + 1.5 * hash2(lx, ly, 11)) * 1000 / RENDER_UNIT_M;
                var base = 700 + Math.min(h, 1500) * 0.35;
                _p.set(px - sceneOrigin.gx, metersToSceneY(base) - pd2 * CURV_K, py - sceneOrigin.gy);
                _s.set(sz, sz * (0.55 + 0.35 * ss(h / 1000)), 1);   // 높은 산은 탑처럼 솟는 구름
                _m.compose(_p, q, _s);
                mesh.setMatrixAt(n, _m);
                var sh = 0.97 * bright;
                _c.setRGB(sh * (1 + 0.2 * warm), sh * (1 - 0.05 * warm), sh * (1 - 0.3 * warm));
                mesh.setColorAt(n, _c);
                n++;
            }
        }
    }
    mesh.count = n;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
}
