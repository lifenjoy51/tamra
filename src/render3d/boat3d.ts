// boat3d.ts — lowpoly 5세기 판재선(선체 + 돛대 + 배튼 돛 + 조타 노 + 사공) 뷰모델 오버레이.
// 메인 씬은 1 unit = 1 world px = 400m 라 16m 배가 0.04 unit 로 사실상 안 보인다.
// 2D 스프라이트(boat-sprite.ts)와 같은 발상으로, 배는 미터 단위 전용 씬 + 전용 카메라(배 뒤·위)로
// 메인 렌더 위에 depth 만 지우고 겹쳐 그린다. 카메라 pitch/FOV 가 메인과 같아 수평선 위치가 일치.
// 조명은 메인 태양광/ambient 를 배 기준 좌표로 돌려 복사, 흘수선 아래는 clipping plane 으로 잘라
// 물에 잠긴 것처럼 보이게 한다. 돛 높이(boat.sail)·활대 각(상대풍)·키(boat.rudder)·너울 흔들림 반영.
import * as THREE from 'three';
import { boat, wind, wave, sail as sailState } from '../state';
import { SCR_W, SCR_H } from '../config';
import type { CelestialRig } from './celestial';

// 배 로컬 좌표: +X = 우현, +Y = 위, -Z = 선수 (three 카메라 기본 forward 와 같은 방향).
const LEN = 15;            // 선체 길이(m)
const BEAM = 2.1;          // 최대 반폭(m)
const MAST_Z = -1.2;       // 돛대 위치(선체 중앙보다 약간 앞)
const MAST_H = 11;         // 갑판 위 돛대 높이
const DECK_Y = 1.05;       // 돛대 밑동 높이(중앙부 갑판)
const SAIL_W = 6.4;
const SAIL_H = 7.2;        // 완전히 올렸을 때 돛 높이
const SAIL_FURL_H = 0.35;  // 접었을 때 활대-하활 간격(배튼이 쌓인 두께)
const BOOM_Y = DECK_Y + 1.6;
const BATTENS = 6;         // 돛 패널 수 (배튼 = 패널 경계)

const WAVE_AMP_TO_M = 0.25; // water.ts 와 같은 환산 (swell amp → m)

const COL = {
    hullA: 0x7a4e2c, hullB: 0x6a4224, wale: 0x3e2614, rim: 0x4a2e18,
    deck: 0xa47a4c, mast: 0x5e4028, sail: 0xd8c49a, batten: 0x5a4128,
    skin: 0xc89870, cloth: 0x3d4a5c,
};

const boatScene = new THREE.Scene();
const boatCam = new THREE.PerspectiveCamera(70, SCR_W / SCR_H, 0.1, 300);
const sunLight = new THREE.DirectionalLight(0xfff2d8, 1);
const ambient = new THREE.AmbientLight(0x8899aa, 1);
// 흘수선: 이 평면 아래(y < waterY)는 잘린다. constant 는 매 프레임 -heave 로 갱신.
const waterPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

const root = new THREE.Group();     // heave/roll/pitch 적용
let sailRig: THREE.Group;           // 돛대 축 회전(활대 각)
let sailMesh: THREE.Mesh;
let battenMeshes: THREE.Mesh[] = [];
let oar: THREE.Group;
let sailDisp = 0;                   // 화면상 돛 높이 비율 (boat.sail 로 부드럽게 수렴)
let built = false;

const _sunDir = new THREE.Vector3();
const _yAxis = new THREE.Vector3(0, 1, 0);

function mat(hex: number, extra?: THREE.MeshStandardMaterialParameters) {
    return new THREE.MeshStandardMaterial(Object.assign({
        color: hex, flatShading: true, roughness: 0.9, metalness: 0,
        side: THREE.DoubleSide, clippingPlanes: [waterPlane],
    }, extra));
}

// 선체 단면 프로파일. u: 0 = 선수, 1 = 선미.
function halfWidth(u: number) {
    var bow = Math.pow(Math.sin(Math.min(u, 0.5) * Math.PI), 0.7);    // 선수는 뾰족
    var stern = 0.55 + 0.45 * Math.pow(Math.sin(Math.max(u, 0.5) * Math.PI), 0.5); // 선미는 뭉툭(트랜섬)
    return BEAM * (u < 0.5 ? Math.max(0.04, bow) : stern);
}
function sheerY(u: number) { var t = 2 * u - 1; return 1.3 + 0.55 * t * t + 0.5 * Math.pow(1 - u, 5); }
function keelY(u: number)  { var t = 2 * u - 1; return -0.75 + 0.7 * Math.pow(Math.abs(t), 3.5); }

// 비인덱스 삼각형 + 면별 vertex color (flatShading 으로 각진 판재 느낌).
function buildHull(): THREE.Mesh {
    var STATIONS = 11;
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
    // 단면 꼭짓점 (한쪽 현): 갑판 테두리 → 상부 외판 → 만곡부 → 용골. side = +1 우현 / -1 좌현.
    function section(u: number, side: number): number[][] {
        var z = -LEN / 2 + u * LEN, hw = halfWidth(u), top = sheerY(u), bot = keelY(u);
        return [
            [side * hw * 0.86, top, z],                        // 0 안쪽 테두리
            [side * hw, top, z],                               // 1 바깥 테두리
            [side * hw * 0.97, bot + (top - bot) * 0.62, z],   // 2 상부 외판
            [side * hw * 0.84, bot + (top - bot) * 0.3, z],    // 3 중부 외판
            [side * hw * 0.5, bot + 0.06, z],                  // 4 만곡부
            [0, bot, z],                                       // 5 용골
            [side * hw * 0.86, top - 0.32, z],                 // 6 갑판 가장자리
        ];
    }
    var strakeCols = [COL.wale, COL.hullA, COL.hullB, COL.hullA];
    for (var s = 0; s < STATIONS - 1; s++) {
        var u0 = s / (STATIONS - 1), u1 = (s + 1) / (STATIONS - 1);
        for (var side = -1; side <= 1; side += 2) {
            var A = section(u0, side), B = section(u1, side);
            quad(A[0], A[1], B[1], B[0], COL.rim);               // 테두리 윗면
            for (var k = 1; k <= 4; k++) quad(A[k], A[k + 1], B[k + 1], B[k], strakeCols[k - 1]); // 외판 4단
            quad(A[0], A[6], B[6], B[0], COL.hullB);             // 안쪽 뱃전
        }
        var P0 = section(u0, -1), P1 = section(u1, -1), S0 = section(u0, 1), S1 = section(u1, 1);
        quad(P0[6], S0[6], S1[6], P1[6], (s & 1) ? COL.deck : 0x9a7044); // 갑판 (판자 줄무늬)
    }
    // 선미 트랜섬: 단면 폴리곤을 팬으로 닫는다
    var P = section(1, -1), S = section(1, 1), center = [0, (sheerY(1) + keelY(1)) / 2, LEN / 2];
    var ring = [P[1], P[2], P[3], P[4], P[5], S[4], S[3], S[2], S[1]];
    for (var r = 0; r < ring.length - 1; r++) tri(center, ring[r], ring[r + 1], COL.hullB);
    tri(center, S[1], P[1], COL.rim);

    var geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    return new THREE.Mesh(geo, mat(0xffffff, { vertexColors: true }));
}

function buildSailRig(): THREE.Group {
    var g = new THREE.Group();
    g.position.set(0, 0, MAST_Z);
    // 돛: 가로 8 × 세로 BATTENS 분할 평면. 정점 y/z 는 updateSail 이 매 프레임 다시 쓴다.
    var geo = new THREE.PlaneGeometry(SAIL_W, 1, 8, BATTENS);
    sailMesh = new THREE.Mesh(geo, mat(COL.sail, { roughness: 1 }));
    sailMesh.position.z = 0.25; // 돛대 바로 뒤에 걸린다
    g.add(sailMesh);
    // 배튼(하활·활대 포함 BATTENS+1 개)
    var bGeo = new THREE.BoxGeometry(SAIL_W + 0.3, 0.09, 0.09);
    var bMat = mat(COL.batten);
    for (var i = 0; i <= BATTENS; i++) {
        var b = new THREE.Mesh(bGeo, bMat);
        b.position.z = 0.25;
        if (i === 0 || i === BATTENS) b.scale.set(1.08, 1.8, 1.8); // 하활·활대는 굵게
        g.add(b);
        battenMeshes.push(b);
    }
    return g;
}

function buildOar(): THREE.Group {
    // 선미 우현 조타 노: 회전축(뱃전 고정점) 기준으로 아래·뒤로 뻗는다
    var g = new THREE.Group();
    g.position.set(halfWidth(0.93) * 0.95, sheerY(0.93), LEN / 2 * 0.86);
    // 길이 L 막대를 a 만큼 아래로 기울여 고정점에서 뒤·아래로. 수면 아래는 clipping 으로 잘린다.
    var L = 4.6, a = 0.95, sa = Math.sin(a), ca = Math.cos(a);
    var shaft = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.14, L), mat(COL.mast));
    shaft.position.set(0, -sa * L / 2, ca * L / 2);
    shaft.rotation.x = a;
    g.add(shaft);
    var blade = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.6, 1.4), mat(COL.mast));
    blade.position.set(0, -sa * (L - 0.6), ca * (L - 0.6));
    blade.rotation.x = a;
    g.add(blade);
    return g;
}

function buildSailor(): THREE.Group {
    // 선미에서 노를 잡은 사공 (몸통 박스 + 머리)
    var g = new THREE.Group();
    var body = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.95, 0.35), mat(COL.cloth));
    body.position.y = 0.48;
    var head = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.3, 0.28), mat(COL.skin));
    head.position.y = 1.12;
    g.add(body, head);
    g.position.set(halfWidth(0.88) * 0.45, sheerY(0.88) - 0.32, LEN / 2 * 0.76);
    return g;
}

function build() {
    built = true;
    boatScene.add(sunLight, sunLight.target, ambient, root);
    root.rotation.order = 'YXZ';
    root.add(buildHull());

    var mast = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.16, MAST_H, 6), mat(COL.mast));
    mast.position.set(0, DECK_Y + MAST_H / 2, MAST_Z);
    root.add(mast);

    sailRig = buildSailRig();
    root.add(sailRig);
    oar = buildOar();
    root.add(oar);
    root.add(buildSailor());

    // 배 뒤 약간 위. pitch 는 메인 카메라(coords.ts applyCameraToThree)와 같게 → 수평선 일치.
    boatCam.position.set(0, 7.0, 21);
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

function updateSail(t: number) {
    sailDisp += (boat.sail - sailDisp) * 0.12;
    var h = SAIL_FURL_H + (SAIL_H - SAIL_FURL_H) * sailDisp;

    var rw = relWind();
    var theta = Math.abs(Math.atan2(rw.s, rw.c));          // 0 = 맞바람, π = 순풍
    // 활대 각: 순풍이면 가로(0), 옆바람일수록 바람 쪽 끝을 앞으로 돌린다 (최대 ~70°).
    var brace = Math.min(1.2, (Math.PI - theta) * 0.6);
    var target = rw.s >= 0 ? brace : -brace;
    sailRig.rotation.y += (target - sailRig.rotation.y) * 0.08;

    // 배부름: 바람세기·돛 높이 비례, 맞바람(IRONS)이면 펄럭임
    var irons = sailState.mode === 'IRONS';
    var fill = Math.min(1, wind.speedMS / 8) * sailDisp * (irons ? 0.15 : 0.7);
    var flutter = irons ? 0.12 * sailDisp : 0;

    var pos = sailMesh.geometry.attributes.position as THREE.BufferAttribute;
    var arr = pos.array as Float32Array;
    for (var i = 0; i < pos.count; i++) {
        var x = arr[i * 3];
        var v = (i / 9 | 0) / BATTENS;                     // PlaneGeometry 행: 0 = 위
        var xn = x / SAIL_W + 0.5;
        arr[i * 3 + 1] = BOOM_Y + h * (1 - v);
        arr[i * 3 + 2] = -fill * Math.sin(Math.PI * xn) * (0.6 + 0.4 * Math.sin(Math.PI * v))
            + flutter * Math.sin(t * 9 + xn * 7 + v * 3);
    }
    pos.needsUpdate = true;
    sailMesh.geometry.computeBoundingSphere();
    for (var b = 0; b <= BATTENS; b++) {
        var bv = b / BATTENS;
        battenMeshes[b].position.y = BOOM_Y + h * bv;
        battenMeshes[b].position.z = 0.25 - fill * (0.6 + 0.4 * Math.sin(Math.PI * bv));
    }
}

// Draw3D 에서 메인 Render3D() 직후 호출.
export function renderBoat3D(renderer: THREE.WebGLRenderer, rig: CelestialRig, camYaw: number) {
    if (!built) build();
    var t = wave.time;

    // 너울: 2D DrawBoat 와 같은 위상식. heave(m) + 파향 성분별 pitch/roll + 바람 쪽 반대로 기울기(heel).
    var sw = wave.swell;
    var phase = boat.gx * sw.dx + boat.gy * sw.dy + t * sw.speed;
    var heave = Math.sin(phase) * sw.amp * WAVE_AMP_TO_M;
    var slope = Math.cos(phase) * Math.min(1, sw.amp / 5);
    var wl = Math.hypot(sw.dx, sw.dy) || 1;
    var wdx = sw.dx / wl, wdy = sw.dy / wl;
    var hx = -Math.sin(boat.angle), hy = -Math.cos(boat.angle);
    var along = wdx * hx + wdy * hy, across = wdx * -hy + wdy * hx;
    var rw = relWind();
    var heel = (rw.s >= 0 ? 1 : -1) * 0.07 * sailDisp * Math.min(1.5, wind.speedMS / 8);
    root.position.y = heave;
    root.rotation.x = 0.05 * slope * along;
    root.rotation.z = 0.08 * slope * across + heel;
    waterPlane.constant = -heave;

    updateSail(t);
    oar.rotation.y += (-boat.rudder * 0.5 - oar.rotation.y) * 0.2;

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
    renderer.localClippingEnabled = true;
    renderer.clearDepth();
    renderer.render(boatScene, boatCam);
    renderer.autoClear = prevAuto;
}
