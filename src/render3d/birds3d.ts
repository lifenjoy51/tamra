// birds3d.ts — 바닷새 (배 뷰모델 씬, 미터 단위). 뭍에서 ~30 km 안, 낮에만, 가까울수록 많다.
// 아침(~11시)엔 뭍에서 바다로 나가고 저녁(15시~)엔 뭍으로 돌아간다 — 옛 뱃사람이 새를 따라 섬을 찾던 단서.
// 한낮엔 배 주변을 맴돈다. 새는 배 기준 좌표에서 날고(배 이동은 무시), 방향만 월드 기준.
import * as THREE from 'three';
import { boat, sun } from '../state';
import { findNearestLand } from '../coast';

const MAXB = 8;
const R_OUT = 130;            // 이 반경(m) 밖으로 나가면 반대편에서 다시
const LAND_FAR_M = 30000, LAND_NEAR_M = 4000;
interface Bird { g: THREE.Group; wl: THREE.Mesh; wr: THREE.Mesh; e: number; s: number; y: number; he: number; hs: number; spd: number; ph: number; on: boolean; turn: number; }
const birds: Bird[] = [];
let landE = 0, landS = 0, landD = Infinity, scanT = 0, scanGx = NaN, scanGy = NaN;

function ss(x: number): number {
    return x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x);
}

export function buildBirds(scene: THREE.Scene) {
    var mat = new THREE.MeshLambertMaterial({ color: 0x3a3c40, side: THREE.DoubleSide });
    // 날개 한 쪽: 몸통에서 바깥으로 뻗은 얇은 삼각형 (길이 0.8m)
    var wg = new THREE.BufferGeometry();
    wg.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, -0.15, 0.8, 0, 0.1, 0, 0, 0.2], 3));
    wg.computeVertexNormals();
    var body = new THREE.BoxGeometry(0.12, 0.1, 0.5);
    for (var i = 0; i < MAXB; i++) {
        var g = new THREE.Group();
        var wl = new THREE.Mesh(wg, mat), wr = new THREE.Mesh(wg, mat);
        wr.scale.x = 1; wl.scale.x = -1;
        g.add(wl, wr, new THREE.Mesh(body, mat));
        g.visible = false;
        scene.add(g);
        birds.push({ g, wl, wr, e: 0, s: 0, y: 10, he: 1, hs: 0, spd: 10, ph: Math.random() * 6, on: false, turn: 0 });
    }
}

// 비행 방향(월드 동·남 단위벡터): 아침 뭍 반대, 저녁 뭍 쪽, 한낮 무작위
function pickHeading(b: Bird) {
    var h = sun.hourLocal, a: number;
    var jit = (Math.random() - 0.5) * 0.8;
    if (landD < Infinity && h < 11) a = Math.atan2(-landE, -landS) + jit;
    else if (landD < Infinity && h > 15) a = Math.atan2(landE, landS) + jit;
    else a = Math.random() * Math.PI * 2;
    b.he = Math.sin(a); b.hs = Math.cos(a);
    b.turn = (h >= 11 && h <= 15) ? (Math.random() - 0.5) * 0.5 : 0;   // 한낮엔 맴돌기
}

function spawn(b: Bird) {
    pickHeading(b);
    // 비행 방향 반대쪽 가장자리에서 들어와 배 근처를 지나가게
    var side = (Math.random() - 0.5) * 80;
    b.e = -b.he * R_OUT * 0.95 + b.hs * side;
    b.s = -b.hs * R_OUT * 0.95 - b.he * side;
    b.y = 7 + Math.random() * 22;
    b.spd = 9 + Math.random() * 4;
    b.on = true;
}

export function updateBirds(dt: number) {
    if (!birds.length) return;
    // 뭍 방향은 2초마다 또는 배가 3px 넘게 움직였을 때만 (75px = 30km 탐색)
    scanT -= dt;
    if (scanT <= 0 || Math.abs(boat.gx - scanGx) > 3 || Math.abs(boat.gy - scanGy) > 3) {
        scanT = 2; scanGx = boat.gx; scanGy = boat.gy;
        var nl = findNearestLand(boat.gx, boat.gy, 75);
        landD = nl.distM; landE = nl.e; landS = nl.s;
    }
    var day = ss((sun.altDeg + 2) / 8);
    var near = landD === Infinity ? 0 : 1 - ss((landD - LAND_NEAR_M) / (LAND_FAR_M - LAND_NEAR_M));
    var want = Math.round(MAXB * day * near);
    var ca = Math.cos(boat.angle), sa = Math.sin(boat.angle);
    for (var i = 0; i < MAXB; i++) {
        var b = birds[i];
        if (!b.on) {
            if (i < want && Math.random() < dt * 0.6) spawn(b);
            b.g.visible = false;
            continue;
        }
        if (b.turn !== 0) {
            var c = Math.cos(b.turn * dt), s = Math.sin(b.turn * dt);
            var ne = b.he * c - b.hs * s, ns = b.he * s + b.hs * c;
            b.he = ne; b.hs = ns;
        }
        b.e += b.he * b.spd * dt; b.s += b.hs * b.spd * dt;
        b.ph += dt * 7;
        if (b.e * b.e + b.s * b.s > R_OUT * R_OUT) {
            b.on = false;
            if (i >= want) { b.g.visible = false; continue; }
            spawn(b);
        }
        // 월드(동·남) → 배 좌표 (x 우현, z 선미)
        var x = b.e * ca - b.s * sa, z = b.e * sa + b.s * ca;
        var hx = b.he * ca - b.hs * sa, hz = b.he * sa + b.hs * ca;
        b.g.position.set(x, b.y + Math.sin(b.ph * 0.3) * 0.5, z);
        b.g.rotation.set(0, Math.atan2(-hx, -hz), 0);
        // 날갯짓: 퍼덕이다 가끔 활공
        var glide = Math.sin(b.ph * 0.13) > 0.4;
        var flap = glide ? 0.05 : Math.sin(b.ph) * 0.6;
        b.wl.rotation.z = -flap; b.wr.rotation.z = flap;
        b.g.visible = true;
    }
}
