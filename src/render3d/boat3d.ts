// boat3d.ts — 5세기 방(舫) 쌍동선 뷰모델 오버레이.
// 준구조선(통나무 밑판 + 현측판, 양끝이 높이 들린 하니와 배 형태) 두 척을 가로보·갑판으로 잇고
// 사각 거적돛 1장 + 노꾼 6 + 조타 노/키잡이. (docs/PERIOD_NOTES.md: 원양은 방 형태로 안정성 확보)
//
// 메인 씬은 1 unit = 1 world px = 400m 라 15m 배가 0.04 unit 로 사실상 안 보인다.
// 2D 스프라이트(boat-sprite.ts)와 같은 발상으로, 배는 미터 단위 전용 씬 + 전용 카메라(배 뒤·위)로
// 메인 렌더 위에 depth 만 지우고 겹쳐 그린다. 카메라 pitch/FOV 가 메인과 같아 수평선 위치가 일치.
// 조명은 메인 태양광/ambient 를 배 기준 좌표로 돌려 복사. 배 주변은 실제 스케일 국소 바다(boat-water.ts)가
// 덮어 잠긴 부분을 가리고, 흔들림도 그 수면을 샘플링한다. 돛 높이(boat.sail)·활대 각(상대풍)·키(boat.rudder)·
// 노(boat.row) 반영 + 항적·뱃머리 물보라·노 물보라.
import * as THREE from 'three';
import { boat, wind, wave, ship, sun, sail as sailState } from '../state';
import { oarSplash } from '../audio';
import { SCR_W, SCR_H } from '../config';
import type { CelestialRig } from './celestial';
import { buildWeather3D, updateWeather3D } from './weather3d';
import { fogStrength } from './sky3d';
import { updateLocalSea, seaHeight, buildSeaPatch, updateSeaPatch, buildFoam, spawnFoam, updateFoam } from './boat-water';

// 배 로컬 좌표: +X = 우현, +Y = 위, -Z = 선수 (three 카메라 기본 forward 와 같은 방향).
const LEN = 13;            // 선체 길이(m)
const HB = 0.85;           // 선체 최대 반폭(m)
const HULL_X = 1.7;        // 두 선체 중심선 간격의 절반
const DECK_Y = 1.08;       // 갑판(가로보 위) 높이
const MAST_Z = -0.6;
const MAST_H = 9;
const SAIL_W = 5.0;
const SAIL_H = 5.6;        // 완전히 올렸을 때 돛 높이
const SAIL_FURL_H = 0.3;   // 내렸을 때 활대-하활 간격(말아 묶은 거적 두께)
const BOOM_Y = DECK_Y + 1.25;
const SAIL_ROWS = 12;      // 거적 엮음 띠 수
const ROWER_Z = [-3.2, -0.4, 2.4];


const COL = {
    rim: 0x4a2e18, plankA: 0x8a5a32, plankB: 0x7d5230, log: 0x5b3a22, logDark: 0x4f321d,
    inner: 0x6a4224, floor: 0x7a5232, deckA: 0xa47a4c, deckB: 0x94693e, beam: 0x5e4028,
    mast: 0x5e4028, matA: 0xc9b07a, matB: 0xb89c66, rope: 0x2e2216,
    skin: 0xc89870, cloth: 0x8a7a5c, clothDark: 0x5c5040,
};

const boatScene = new THREE.Scene();
const boatCam = new THREE.PerspectiveCamera(70, SCR_W / SCR_H, 0.1, 300);
const sunLight = new THREE.DirectionalLight(0xfff2d8, 1);
const ambient = new THREE.AmbientLight(0x8899aa, 1);

const root = new THREE.Group();     // heave/roll/pitch 적용
let seaPatch: THREE.Mesh;
let sailRig: THREE.Group;           // 돛대 축 회전(활대 각)
let sailMesh: THREE.Mesh;
let yard: THREE.Mesh;
let boom: THREE.Mesh;
let steerOar: THREE.Group;
let lanternLight: THREE.PointLight;
let lanternMat: THREE.MeshStandardMaterial;
let lanternOn = 0;
interface Rower { oar: THREE.Group; torso: THREE.Group; phase: number; wasIn: boolean; }
const rowers: Rower[] = [];
let sailDisp = 0;                   // 화면상 돛 높이 비율 (boat.sail 로 부드럽게 수렴)
let rowBlend = 0;                   // 0 = 노 걷어 올림, 1 = 젓는 중
let rowPhase = 0;
let built = false;
let heaveS = 0, pitchS = 0, rollS = 0;  // 수면 샘플을 관성으로 따라가는 자세

const _sunDir = new THREE.Vector3();
const _yAxis = new THREE.Vector3(0, 1, 0);
const _tip = new THREE.Vector3();

function mat(hex: number, extra?: THREE.MeshStandardMaterialParameters) {
    return new THREE.MeshStandardMaterial(Object.assign({
        color: hex, flatShading: true, roughness: 0.9, metalness: 0,
        side: THREE.DoubleSide,
    }, extra));
}
function box(w: number, h: number, d: number, hex: number) {
    return new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat(hex));
}

// 준구조선 단면 프로파일. u: 0 = 선수, 1 = 선미. 양끝이 급격히 들린다(하니와 배 형태).
function halfWidth(u: number) { var t = Math.abs(2 * u - 1); return Math.max(0.03, HB * Math.pow(1 - Math.pow(t, 2.2), 0.6)); }
function sheerY(u: number)    { var t = Math.abs(2 * u - 1); return 0.95 + 1.5 * Math.pow(t, 5); }
function seamY(u: number)     { var t = Math.abs(2 * u - 1); return 0.35 + 0.9 * Math.pow(t, 4); }  // 통나무 밑판 ↔ 현측판 이음
function keelY(u: number)     { var t = Math.abs(2 * u - 1); return -0.5 + 0.75 * Math.pow(t, 3); }

// 비인덱스 삼각형 + 면별 vertex color (flatShading 으로 각진 판재 느낌). 선체 1척, 중심선 x=0.
function buildHull(): THREE.Mesh {
    var STATIONS = 15;
    var pos: number[] = [], col: number[] = [];
    var c = new THREE.Color();
    function tri(a: number[], b: number[], d: number[], hex: number) {
        pos.push(a[0], a[1], a[2], b[0], b[1], b[2], d[0], d[1], d[2]);
        c.setHex(hex);
        for (var k = 0; k < 3; k++) col.push(c.r, c.g, c.b);
    }
    function quad(a: number[], b: number[], cc: number[], d: number[], hex: number) {
        tri(a, b, cc, hex); tri(a, cc, d, hex);
    }
    // 단면 꼭짓점 (한쪽 현). side = +1 우현 / -1 좌현.
    function section(u: number, side: number): number[][] {
        var z = -LEN / 2 + u * LEN, hw = halfWidth(u), top = sheerY(u), seam = seamY(u), bot = keelY(u);
        return [
            [side * hw * 0.8, top, z],                       // 0 안쪽 테두리
            [side * hw, top, z],                             // 1 바깥 테두리
            [side * hw * 1.03, (top + seam) / 2, z],         // 2 현측판 중간
            [side * hw * 0.98, seam, z],                     // 3 이음선
            [side * hw * 0.7, bot + (seam - bot) * 0.25, z], // 4 통나무 만곡부
            [0, bot, z],                                     // 5 용골
            [side * hw * 0.68, seam - 0.12, z],              // 6 안쪽 바닥 가장자리
        ];
    }
    for (var s = 0; s < STATIONS - 1; s++) {
        var u0 = s / (STATIONS - 1), u1 = (s + 1) / (STATIONS - 1);
        for (var side = -1; side <= 1; side += 2) {
            var A = section(u0, side), B = section(u1, side);
            quad(A[0], A[1], B[1], B[0], COL.rim);                       // 테두리 윗면
            quad(A[1], A[2], B[2], B[1], COL.plankA);                    // 현측판 위
            quad(A[2], A[3], B[3], B[2], COL.plankB);                    // 현측판 아래
            quad(A[3], A[4], B[4], B[3], COL.log);                       // 통나무 밑판
            quad(A[4], A[5], B[5], B[4], COL.logDark);
            quad(A[0], A[6], B[6], B[0], COL.inner);                     // 안쪽 뱃전
        }
        var P0 = section(u0, -1), P1 = section(u1, -1), S0 = section(u0, 1), S1 = section(u1, 1);
        quad(P0[6], S0[6], S1[6], P1[6], COL.floor);                     // 안쪽 바닥
    }
    // 수판(竪板): 양끝 안쪽을 막는 세움판. 현측판 끝이 그 위로 솟아 갈라진 뱃머리 실루엣이 된다.
    for (var e = 0; e < 2; e++) {
        var ue = e ? 0.9 : 0.1, ze = -LEN / 2 + ue * LEN, hwE = halfWidth(ue) * 0.95;
        var yLo = seamY(ue) - 0.1, yHi = sheerY(ue) - 0.25;
        quad([-hwE, yLo, ze], [hwE, yLo, ze], [hwE, yHi, ze], [-hwE, yHi, ze], COL.plankB);
    }
    var geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    return new THREE.Mesh(geo, mat(0xffffff, { vertexColors: true }));
}

function buildPlatform(): THREE.Group {
    var g = new THREE.Group();
    // 가로보 4개 — 두 선체 바깥 뱃전까지 걸친다
    for (var i = 0; i < 4; i++) {
        var b = box(2 * (HULL_X + HB) + 0.3, 0.16, 0.2, COL.beam);
        b.position.set(0, DECK_Y - 0.1, -3.3 + i * 2.2);
        g.add(b);
    }
    // 갑판 판자 (선체 사이 + 안쪽 뱃전 위로 살짝 걸침)
    var PLANKS = 7, span = 7.0, pw = span / PLANKS;
    for (var p = 0; p < PLANKS; p++) {
        var d = box(2 * (HULL_X - HB * 0.55), 0.07, pw * 0.94, (p & 1) ? COL.deckA : COL.deckB);
        d.position.set(0, DECK_Y, -span / 2 + pw * (p + 0.5));
        g.add(d);
    }
    return g;
}

function buildSailRig(): THREE.Group {
    var g = new THREE.Group();
    g.position.set(0, 0, MAST_Z);
    // 거적돛: 가로 6 × 세로 SAIL_ROWS. 행마다 색을 번갈아 엮음 띠 표현. 정점 y/z 는 updateSail 이 갱신.
    var geo = new THREE.PlaneGeometry(SAIL_W, 1, 6, SAIL_ROWS).toNonIndexed();
    var posA = geo.attributes.position as THREE.BufferAttribute;
    var cols = new Float32Array(posA.count * 3), ca = new THREE.Color(COL.matA), cb = new THREE.Color(COL.matB);
    for (var f = 0; f < posA.count / 3; f++) {
        // 삼각형 무게중심 y(-0.5~0.5) → 행 번호 → 색
        var cy = (posA.getY(f * 3) + posA.getY(f * 3 + 1) + posA.getY(f * 3 + 2)) / 3 + 0.5;
        var cc = ((cy * SAIL_ROWS) | 0) & 1 ? ca : cb;
        for (var k = 0; k < 3; k++) { cols[(f * 3 + k) * 3] = cc.r; cols[(f * 3 + k) * 3 + 1] = cc.g; cols[(f * 3 + k) * 3 + 2] = cc.b; }
    }
    geo.setAttribute('color', new THREE.BufferAttribute(cols, 3));
    // 원래 v(0=위,1=아래)를 보존해 updateSail 에서 재사용
    var vs = new Float32Array(posA.count), xs = new Float32Array(posA.count);
    for (var i = 0; i < posA.count; i++) { vs[i] = 0.5 - posA.getY(i); xs[i] = posA.getX(i); }
    geo.userData = { v: vs, x: xs };
    sailMesh = new THREE.Mesh(geo, mat(0xffffff, { vertexColors: true, roughness: 1 }));
    sailMesh.position.z = 0.2; // 돛대 바로 뒤
    g.add(sailMesh);
    yard = box(SAIL_W + 0.6, 0.14, 0.14, COL.mast);
    boom = box(SAIL_W + 0.4, 0.12, 0.12, COL.mast);
    yard.position.z = boom.position.z = 0.2;
    boom.position.y = BOOM_Y;
    g.add(yard, boom);
    return g;
}

function buildPerson(clothHex: number, torsoH: number): { g: THREE.Group; torso: THREE.Group } {
    var g = new THREE.Group();
    var torso = new THREE.Group();     // 허리 기준 회전(노 젓는 몸짓)
    var body = box(0.42, torsoH, 0.3, clothHex);
    body.position.y = torsoH / 2;
    var head = box(0.26, 0.28, 0.26, COL.skin);
    head.position.y = torsoH + 0.17;
    var hair = box(0.28, 0.1, 0.28, 0x1e1a16);   // 상투/머리
    hair.position.y = torsoH + 0.33;
    torso.add(body, head, hair);
    g.add(torso);
    return { g, torso };
}

// 노꾼 + 노 (우현 기준으로 만들고 좌현은 부모 scale.x = -1 로 미러)
function buildRowerSide(): THREE.Group {
    var side = new THREE.Group();
    for (var i = 0; i < ROWER_Z.length; i++) {
        var z = ROWER_Z[i], u = (z + LEN / 2) / LEN;
        var person = buildPerson(i & 1 ? COL.cloth : COL.clothDark, 0.62);
        person.g.position.set(HULL_X - 0.1, seamY(u) + 0.05, z);
        side.add(person.g);
        // 노: 바깥 뱃전 고정점에서 바깥(+X)·아래로. 손잡이는 안쪽 1m.
        var oar = new THREE.Group();
        oar.rotation.order = 'YZX';
        oar.position.set(HULL_X + halfWidth(u), sheerY(u) + 0.05, z);
        var shaft = box(4.4, 0.07, 0.07, COL.mast);
        shaft.position.x = 1.2;
        var blade = box(0.9, 0.04, 0.26, COL.mast);
        blade.position.x = 3.1;
        oar.add(shaft, blade);
        side.add(oar);
        rowers.push({ oar, torso: person.torso, phase: i * 0.15, wasIn: false });
    }
    return side;
}

function buildSteering(): THREE.Group {
    // 우현 선체 선미 바깥쪽 조타 노 + 선 채로 잡은 키잡이
    var g = new THREE.Group();
    var u = 0.88, z = -LEN / 2 + u * LEN;
    steerOar = new THREE.Group();
    steerOar.position.set(HULL_X + halfWidth(u) * 0.95, sheerY(u), z);
    var L = 4.4, a = 0.95, sa = Math.sin(a), ca = Math.cos(a);
    var shaft = box(0.13, 0.13, L, COL.mast);
    shaft.position.set(0, -sa * L / 2, ca * L / 2);
    shaft.rotation.x = a;
    var blade = box(0.07, 0.55, 1.3, COL.mast);
    blade.position.set(0, -sa * (L - 0.6), ca * (L - 0.6));
    blade.rotation.x = a;
    steerOar.add(shaft, blade);
    g.add(steerOar);
    var helm = buildPerson(COL.clothDark, 0.95);
    helm.g.position.set(HULL_X, seamY(u) - 0.05, z - 0.6);
    g.add(helm.g);
    return g;
}

// 갑판 선미 쪽 기둥에 건 등불 — 해 지면 켜진다 (점광원 + 발광 상자)
function buildLantern(): THREE.Group {
    var g = new THREE.Group();
    g.position.set(0.6, DECK_Y, 3.3);
    var post = box(0.08, 1.6, 0.08, COL.mast);
    post.position.y = 0.8;
    lanternMat = mat(0x3a2a1a, { emissive: new THREE.Color(0xffb060), emissiveIntensity: 0 });
    var lamp = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.28, 0.22), lanternMat);
    lamp.position.y = 1.45;
    lanternLight = new THREE.PointLight(0xffb060, 0, 16, 2);
    lanternLight.position.y = 1.45;
    g.add(post, lamp, lanternLight);
    return g;
}

function buildStays(): THREE.LineSegments {
    // 돛대 지삭: 꼭대기 → 양 선체 뱃머리/선미
    var top = [0, DECK_Y + MAST_H, MAST_Z], pts: number[] = [];
    var ends = [[HULL_X, sheerY(0.06), -LEN / 2 + 0.06 * LEN], [-HULL_X, sheerY(0.06), -LEN / 2 + 0.06 * LEN],
                [HULL_X, sheerY(0.94), -LEN / 2 + 0.94 * LEN], [-HULL_X, sheerY(0.94), -LEN / 2 + 0.94 * LEN]];
    for (var i = 0; i < ends.length; i++) pts.push(top[0], top[1], top[2], ends[i][0], ends[i][1], ends[i][2]);
    var geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    return new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: COL.rope }));
}

function build() {
    built = true;
    seaPatch = buildSeaPatch();
    boatScene.add(sunLight, sunLight.target, ambient, root, seaPatch, buildFoam());
    buildWeather3D(boatScene);
    boatScene.fog = new THREE.Fog(0xffffff, 1e4, 2e4);
    root.rotation.order = 'YXZ';

    var hullGeoMesh = buildHull();
    var hullS = hullGeoMesh, hullP = new THREE.Mesh(hullGeoMesh.geometry, hullGeoMesh.material);
    hullS.position.x = HULL_X;
    hullP.position.x = -HULL_X;
    root.add(hullS, hullP, buildPlatform());

    var mast = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.14, MAST_H, 6), mat(COL.mast));
    mast.position.set(0, DECK_Y + MAST_H / 2, MAST_Z);
    root.add(mast, buildStays());

    sailRig = buildSailRig();
    root.add(sailRig);

    var starboard = buildRowerSide();
    var port = buildRowerSide();
    port.scale.x = -1;
    root.add(starboard, port, buildSteering(), buildLantern());

    // 배 뒤 약간 위. pitch 는 메인 카메라(coords.ts applyCameraToThree)와 같게 → 수평선 일치.
    boatCam.position.set(0, 6.2, 19);
    boatCam.rotation.set(-0.05, 0, 0);
}

// 상대풍: 바람이 불어오는 방향을 배 기준으로. s>0 = 우현에서, c>0 = 선수 쪽에서.
// wind.angleRad 는 0=북, π/2=동(불어오는 방향). 월드 좌표 x=동, y=남.
function relWind() {
    var fx = Math.sin(wind.angleRad), fy = -Math.cos(wind.angleRad);   // 불어오는 쪽 단위벡터
    var hx = -Math.sin(boat.angle), hy = -Math.cos(boat.angle);         // 선수 (moveBoat 와 동일)
    var rx = -hy, ry = hx;                                              // 우현
    return { s: fx * rx + fy * ry, c: fx * hx + fy * hy };
}

function updateSail(t: number, rw: { s: number; c: number }) {
    sailDisp += (boat.sail - sailDisp) * 0.12;
    var h = SAIL_FURL_H + (SAIL_H - SAIL_FURL_H) * sailDisp;

    var theta = Math.abs(Math.atan2(rw.s, rw.c));          // 0 = 맞바람, π = 순풍
    // 활대 각: 순풍이면 가로(0), 옆바람일수록 바람 쪽 끝을 앞으로 돌린다 (최대 ~70°).
    var brace = Math.min(1.2, (Math.PI - theta) * 0.6);
    var target = rw.s >= 0 ? brace : -brace;
    sailRig.rotation.y += (target - sailRig.rotation.y) * 0.08;

    // 배부름: 바람세기·돛 높이 비례, 맞바람(IRONS)이면 펄럭임
    var irons = sailState.mode === 'IRONS';
    var fill = Math.min(1, wind.speedMS / 8) * sailDisp * (irons ? 0.15 : 0.8);
    var flutter = irons ? 0.12 * sailDisp : 0;

    var pos = sailMesh.geometry.attributes.position as THREE.BufferAttribute;
    var arr = pos.array as Float32Array;
    var ud = sailMesh.geometry.userData as { v: Float32Array; x: Float32Array };
    for (var i = 0; i < pos.count; i++) {
        var v = ud.v[i], xn = ud.x[i] / SAIL_W + 0.5;
        arr[i * 3 + 1] = BOOM_Y + h * (1 - v);
        arr[i * 3 + 2] = -fill * Math.sin(Math.PI * xn) * (0.5 + 0.5 * Math.sin(Math.PI * v))
            + flutter * Math.sin(t * 9 + xn * 7 + v * 3);
    }
    pos.needsUpdate = true;
    sailMesh.geometry.computeBoundingSphere();
    yard.position.y = BOOM_Y + h;
}

function updateRowers() {
    rowBlend += (boat.row - rowBlend) * 0.08;
    if (rowBlend > 0.01) rowPhase += 0.15;
    for (var i = 0; i < rowers.length; i++) {
        var r = rowers[i], p = rowPhase + r.phase;
        // 젓기: 앞으로 뻗어 물에 꽂고(catch) 뒤로 당긴 뒤(sin>0 구간 = 물속) 들어 올려 되돌린다.
        // 쉼: 노를 뒤로 눕혀 들어 올린 상태.
        var sweep = 0.45 * Math.cos(p), drop = 0.32 + 0.14 * Math.sin(p);
        r.oar.rotation.y = -1.15 + (sweep + 1.15) * rowBlend;
        r.oar.rotation.z = 0.2 + (-drop - 0.2) * rowBlend;
        r.torso.rotation.x = 0.3 * Math.cos(p) * rowBlend;
        // 노깃이 물에 들어가는 순간(catch) 물보라
        var isIn = rowBlend > 0.5 && Math.sin(p) > 0;
        if (isIn && !r.wasIn) {
            if (i === 0) oarSplash();     // 같은 박자 노꾼들 — 소리는 한 번
            r.oar.updateWorldMatrix(true, false);
            _tip.set(3.3, 0, 0);
            r.oar.localToWorld(_tip);   // 씬 좌표 = 파티클 좌표계
            for (var k = 0; k < 4; k++) {
                spawnFoam(_tip.x, seaHeight(_tip.x, _tip.z) + 0.05, _tip.z,
                    (Math.random() - 0.5) * 1.2, 1.2 + Math.random() * 1.2, (Math.random() - 0.5) * 1.2, 0.9, false);
            }
        }
        r.wasIn = isIn;
    }
}

// 항적: 두 선체 뱃머리에서 Kelvin 각(~19.5°)으로 퍼지는 V + 선체 옆 거품 + 파도에 박힐 때 물보라.
let bowPrev = [0, 0];
function updateWake(v: number) {
    var spread = v * 0.35;
    var n = v > 0.15 ? Math.min(2, v * 0.35) : 0;
    for (var h = 0; h < 2; h++) {
        var hxs = h ? HULL_X : -HULL_X;
        var bowZ = -LEN / 2 + 0.9;
        var bowSea = seaHeight(hxs, bowZ);
        for (var k = 0; k < n; k++) {
            if (Math.random() > n - k) break;
            var side = Math.random() < 0.5 ? -1 : 1;
            spawnFoam(hxs + side * (HB * 0.6), bowSea, bowZ + Math.random() * 1.5,
                side * spread * (0.7 + Math.random() * 0.6), 0, 0, 3 + Math.random() * 2.5, true);
        }
        // 선체 옆 흘수선 거품 (파도가 선체를 칠 때도 조금)
        if (Math.random() < 0.25 + v * 0.3) {
            var zs = -LEN / 2 + 2 + Math.random() * (LEN - 4), sd = Math.random() < 0.5 ? -1 : 1;
            spawnFoam(hxs + sd * HB * 1.05, seaHeight(hxs + sd * HB, zs), zs, sd * 0.3, 0, 0, 1.5 + Math.random(), true);
        }
        // 뱃머리가 수면 대비 빠르게 내려가면(파도에 박힘) 물보라 — 속도·파고 비례
        var rel = root.position.y - root.rotation.x * bowZ - bowSea;   // 뱃머리 높이 - 수면
        var dig = bowPrev[h] - rel;
        bowPrev[h] = rel;
        if (dig > 0.02 && v > 0.8) {
            var cnt = Math.min(10, (dig * 60 * v) | 0);
            for (var q = 0; q < cnt; q++) {
                spawnFoam(hxs + (Math.random() - 0.5) * HB, bowSea + 0.2, bowZ - 0.3,
                    (Math.random() - 0.5) * 2.5, 2 + Math.random() * 2.5 * Math.min(1, v / 3), -v * 0.3, 1.2, false);
            }
        }
    }
}

// Draw3D 에서 메인 Render3D() 직후 호출.
export function renderBoat3D(renderer: THREE.WebGLRenderer, rig: CelestialRig, camYaw: number, fog: THREE.Fog) {
    if (!built) build();
    var t = wave.time;

    // 대수속력(돛+노)을 실시간 m/s 로 그대로 사용 — 물결·항적이 배 속도대로 뒤로 흐른다.
    var v = ship.waterMS;
    updateLocalSea(v);
    // 흔들림: 선수/선미/좌우 선체 수면 높이 → heave·pitch·roll. 쌍동선은 수면을 거의 그대로 탄다.
    // 관성 smoothing 으로 짧은 잔물결엔 덜 반응. 바람 반대쪽 기울기(heel)는 단동선보다 작게.
    var zb = -LEN / 2 + 1.5, zs = LEN / 2 - 1.5;
    var hb = (seaHeight(-HULL_X, zb) + seaHeight(HULL_X, zb)) / 2;
    var hs = (seaHeight(-HULL_X, zs) + seaHeight(HULL_X, zs)) / 2;
    var hp = (seaHeight(-HULL_X, zb) + seaHeight(-HULL_X, zs)) / 2;
    var hr = (seaHeight(HULL_X, zb) + seaHeight(HULL_X, zs)) / 2;
    var rw = relWind();
    var heel = (rw.s >= 0 ? 1 : -1) * 0.03 * sailDisp * Math.min(1.5, wind.speedMS / 8);
    heaveS += ((hb + hs) / 2 - heaveS) * 0.35;
    pitchS += (Math.atan2(hb - hs, zs - zb) - pitchS) * 0.3;
    rollS  += (Math.atan2(hr - hp, 2 * HULL_X) - rollS) * 0.3;   // +z 회전 = 우현이 올라감
    root.position.y = heaveS;
    root.rotation.x = pitchS;
    root.rotation.z = rollS + heel;

    updateSail(t, rw);
    updateRowers();
    updateWake(v);
    updateFoam(v);
    updateSeaPatch(seaPatch);
    updateWeather3D(v);
    // 짙은 안개면 배 자체도 흐려진다 (메인 씬 fog 는 400m/unit 라 배 거리에선 효과 없음)
    var bf = boatScene.fog as THREE.Fog, fs = fogStrength();
    bf.color.copy(fog.color);
    bf.far = fs > 0 ? 25 + 400 * (1 - fs) * (1 - fs) : 2e4;
    bf.near = bf.far * 0.15;
    steerOar.rotation.y += (-boat.rudder * 0.5 - steerOar.rotation.y) * 0.2;
    // 등불: 해가 -2° 아래로 지면 서서히 켜지고 불꽃처럼 일렁인다
    lanternOn += ((sun.altDeg < -2 ? 1 : 0) - lanternOn) * 0.05;
    var flick = 0.85 + 0.15 * Math.sin(t * 23) * Math.sin(t * 7.3);
    lanternLight.intensity = lanternOn * flick * 6;
    lanternMat.emissiveIntensity = lanternOn * flick * 2.5;

    // 메인 씬 조명을 배 좌표계(선수 = -Z)로 회전해 복사
    _sunDir.copy(rig.sunLight.position).sub(rig.sunLight.target.position).normalize()
        .applyAxisAngle(_yAxis, -camYaw);
    sunLight.position.copy(_sunDir).multiplyScalar(50);
    sunLight.intensity = rig.sunLight.intensity;
    sunLight.color.copy(rig.sunLight.color);
    ambient.intensity = rig.ambient.intensity;
    ambient.color.copy(rig.ambient.color);

    var prevAuto = renderer.autoClear;
    renderer.autoClear = false;
    renderer.clearDepth();
    renderer.render(boatScene, boatCam);
    renderer.autoClear = prevAuto;
}
