// boat3d.ts — 5세기 목선 뷰모델 오버레이. 2D 스프라이트(boat.png)와 같은 형태:
// 폭 넓은 단동 선체(둥근 바닥·뭉툭한 양끝·선미 판) + 갑판 + 선미 쪽으로 들린 뱃전 난간,
// 중앙 돛대 1개 + 가로 활대로 나뉜 사각 거적돛(5칸), 선미 중앙 키 + 키 손잡이 받침.
//
// 메인 씬은 1 unit = 1 world px = 400m 라 11m 배가 0.03 unit 로 사실상 안 보인다.
// 2D 스프라이트(boat-sprite.ts)와 같은 발상으로, 배는 미터 단위 전용 씬 + 전용 카메라(배 뒤·위)로
// 메인 렌더 위에 depth 만 지우고 겹쳐 그린다. 카메라 pitch/높이가 메인과 같아 수평선 위치가 일치.
// 조명은 메인 태양광/ambient 를 배 기준 좌표로 돌려 복사. 배 주변은 실제 스케일 국소 바다(boat-water.ts)가
// 덮어 잠긴 부분을 가리고, 흔들림도 그 수면을 샘플링한다. 돛 높이(boat.sail)·활대 각(상대풍)·키(boat.rudder)·
// 노(boat.row — 저을 때만 노꾼이 보인다) 반영 + 항적·뱃머리 물보라·노 물보라.
import * as THREE from 'three';
import { boat, wind, wave, ship, sun, sail as sailState } from '../state';
import { oarSplash } from '../audio';
import { SCR_W, SCR_H } from '../config';
import { FOV_V } from './renderer';
import { VIEW_HEIGHT_M, CAM_PITCH, chase } from './coords';
import type { CelestialRig } from './celestial';
import { buildWeather3D, updateWeather3D } from './weather3d';
import { fogStrength } from './sky3d';
import { updateLocalSea, seaHeight, buildSeaPatch, updateSeaPatch, buildFoam, spawnFoam, updateFoam } from './boat-water';

// 배 로컬 좌표: +X = 우현, +Y = 위, -Z = 선수 (three 카메라 기본 forward 와 같은 방향).
const LEN = 11;            // 선체 길이(m)
const HB = 2.2;            // 선체 최대 반폭(m)
const ROLL_X = HB * 0.8;   // 횡동요 샘플 지점(좌우 현)
const DECK_Y = 1.1;        // 갑판 높이
const MAST_Z = -0.8;
const MAST_H = 9.5;
const SAIL_W = 4.4;
const SAIL_H = 6.0;        // 완전히 올렸을 때 돛 높이
const SAIL_FURL_H = 0.35;  // 내렸을 때 활대-하활 간격(접어 묶은 거적 두께)
const SAIL_PANELS = 5;     // 가로 활대로 나뉜 칸 수 (boat.png 와 같음)
const BOOM_Y = DECK_Y + 1.6;       // 하활 — 난간 위
const BITT_Z = LEN / 2 - 1.5;      // 키 손잡이 받침 기둥
const ROWER_Z = [-2.2, 1.0];

const COL = {
    rim: 0x4a2e18, plankA: 0x8a5a32, plankB: 0x7d5230, log: 0x5b3a22, logDark: 0x4f321d,
    inner: 0x6a4224, floor: 0x7a5232, deckA: 0xa47a4c, deckB: 0x94693e, beam: 0x5e4028,
    mast: 0x5e4028, matA: 0xc9b07a, matB: 0xb89c66, rope: 0x2e2216,
    skin: 0xc89870, cloth: 0x8a7a5c, clothDark: 0x5c5040,
};

const boatScene = new THREE.Scene();
// 키잡이 1인칭: 메인 카메라와 같은 FOV·pitch·눈높이 → 두 씬의 원근·수평선 일치
const boatCam = new THREE.PerspectiveCamera(FOV_V, SCR_W / SCR_H, 0.05, 300);
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
let speedDisp = 0;                  // 화면상 대수속력 (ship.waterMS 로 관성 수렴)
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

// 선체 프로파일. u: 0 = 선수, 1 = 선미. 평면형은 둥글고 양끝이 뭉툭하다(선미가 더 넓은 판).
function halfWidth(u: number) {
    var t = Math.abs(2 * u - 1), endW = u < 0.5 ? 0.3 : 0.62;
    return HB * (endW + (1 - endW) * Math.sqrt(Math.max(0, 1 - Math.pow(t, 2.5))));
}
// 뱃전 높이: 선미 양 모서리로 갈수록 크게 들리고(boat.png 의 휘어 올라간 난간), 선수도 조금 들린다.
function sheerY(u: number) {
    var st = Math.max(0, (u - 0.7) / 0.3), bw = Math.max(0, (0.25 - u) / 0.25);
    return 1.5 + 0.7 * st * st + 0.3 * bw * bw;
}
function keelY(u: number)  { var t = Math.abs(2 * u - 1); return -0.75 + 0.55 * Math.pow(t, 3); }
function bilgeY(u: number) { return keelY(u) * 0.25 + 0.15; }

// 비인덱스 삼각형 + 면별 vertex color (flatShading 으로 각진 판재 느낌). 중심선 x=0.
function buildHull(): THREE.Mesh {
    var STATIONS = 17;
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
    // 단면 꼭짓점 (한쪽 현). side = +1 우현 / -1 좌현. 0~1 = 뱃전 윗면, 1~5 = 바깥 판재, 5 = 용골.
    function section(u: number, side: number): number[][] {
        var z = -LEN / 2 + u * LEN, hw = halfWidth(u), top = sheerY(u), bg = bilgeY(u), kb = keelY(u);
        return [
            [side * (hw - 0.14), top, z],                    // 0 안쪽 테두리
            [side * hw, top, z],                             // 1 바깥 테두리
            [side * hw * 1.02, top - 0.22, z],               // 2 덧댄 띠(wale) 아래
            [side * hw * 1.02, (top + bg) / 2, z],           // 3 현측판 중간
            [side * hw * 0.92, bg, z],                       // 4 만곡부
            [side * hw * 0.5, kb + 0.12, z],                 // 5 바닥판
            [0, kb, z],                                      // 6 용골
            [side * (hw - 0.14), DECK_Y, z],                 // 7 안쪽 뱃전 ↔ 갑판
        ];
    }
    for (var s = 0; s < STATIONS - 1; s++) {
        var u0 = s / (STATIONS - 1), u1 = (s + 1) / (STATIONS - 1);
        for (var side = -1; side <= 1; side += 2) {
            var A = section(u0, side), B = section(u1, side);
            quad(A[0], A[1], B[1], B[0], COL.rim);                       // 뱃전 윗면
            quad(A[1], A[2], B[2], B[1], COL.rim);                       // 덧댄 띠
            quad(A[2], A[3], B[3], B[2], (s & 1) ? COL.plankA : COL.plankB);
            quad(A[3], A[4], B[4], B[3], (s & 1) ? COL.plankB : COL.plankA);
            quad(A[4], A[5], B[5], B[4], COL.log);
            quad(A[5], A[6], B[6], B[5], COL.logDark);
            quad(A[0], A[7], B[7], B[0], COL.inner);                     // 안쪽 뱃전
        }
    }
    // 선수·선미 막음판: 양현 단면을 그대로 이어 붙인다.
    for (var e = 0; e < 2; e++) {
        var P = section(e, -1), S = section(e, 1);
        for (var i = 1; i < 6; i++) quad(P[i], S[i], S[i + 1], P[i + 1], e ? COL.plankB : COL.plankA);
        quad(P[0], S[0], S[7], P[7], COL.inner);
        quad(P[0], P[1], S[1], S[0], COL.rim);
    }
    var geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    return new THREE.Mesh(geo, mat(0xffffff, { vertexColors: true }));
}

function buildDeck(): THREE.Group {
    var g = new THREE.Group();
    // 갑판 판자: 세로(선수-선미) 방향으로 깔린 판자를 가로 띠로 잘라 선체 평면형에 맞춘다.
    var ROWS = 22;
    for (var r = 0; r < ROWS; r++) {
        var u = (r + 0.5) / ROWS, w = 2 * (halfWidth(u) - 0.14);
        var d = box(w, 0.08, LEN / ROWS * 1.02, (r & 1) ? COL.deckA : COL.deckB);
        d.position.set(0, DECK_Y, -LEN / 2 + u * LEN);
        g.add(d);
    }
    // 갑판 판자 이음줄 (가로 간격 0.45m)
    for (var x = -HB + 0.45; x < HB; x += 0.45) {
        var seam = box(0.03, 0.09, LEN * 0.9, COL.beam);
        seam.position.set(x, DECK_Y + 0.005, 0.2);
        seam.scale.z = Math.min(1, 1.15 - Math.abs(x) / HB);
        g.add(seam);
    }
    // 선미 가로 난간 (boat.png 의 선미 가로대) + 받침 기둥
    var sz = LEN / 2 - 0.9, sw = halfWidth(0.92) * 2;
    var rail = box(sw, 0.14, 0.16, COL.rim);
    rail.position.set(0, sheerY(0.92) - 0.15, sz);
    g.add(rail);
    for (var k = -2; k <= 2; k++) {
        var post = box(0.1, sheerY(0.92) - DECK_Y, 0.1, COL.rim);
        post.position.set(k * sw / 5, (sheerY(0.92) + DECK_Y) / 2 - 0.1, sz);
        g.add(post);
    }
    // 키 손잡이 받침 기둥 2개 + 가로대
    for (var b = -1; b <= 1; b += 2) {
        var bitt = box(0.16, 0.8, 0.16, COL.beam);
        bitt.position.set(b * 0.32, DECK_Y + 0.4, BITT_Z);
        g.add(bitt);
    }
    var cross = box(0.9, 0.12, 0.14, COL.beam);
    cross.position.set(0, DECK_Y + 0.7, BITT_Z);
    g.add(cross);
    return g;
}

const battens: THREE.Mesh[] = [];
function buildSailRig(): THREE.Group {
    var g = new THREE.Group();
    g.position.set(0, 0, MAST_Z);
    // 거적돛: 칸마다 3행 엮음 띠를 번갈아 칠한다. 정점 y/z 는 updateSail 이 갱신.
    var ROWS = SAIL_PANELS * 3;
    var geo = new THREE.PlaneGeometry(SAIL_W, 1, 8, ROWS).toNonIndexed();
    var posA = geo.attributes.position as THREE.BufferAttribute;
    var cols = new Float32Array(posA.count * 3), ca = new THREE.Color(COL.matA), cb = new THREE.Color(COL.matB);
    for (var f = 0; f < posA.count / 3; f++) {
        var cy = (posA.getY(f * 3) + posA.getY(f * 3 + 1) + posA.getY(f * 3 + 2)) / 3 + 0.5;
        var cc = ((cy * ROWS) | 0) & 1 ? ca : cb;
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
    yard = box(SAIL_W + 0.3, 0.14, 0.14, COL.mast);
    boom = box(SAIL_W + 0.3, 0.14, 0.14, COL.mast);
    yard.position.z = boom.position.z = 0.2;
    boom.position.y = BOOM_Y;
    g.add(yard, boom);
    // 칸 사이 가로 활대(batten)
    for (var p = 1; p < SAIL_PANELS; p++) {
        var bt = box(SAIL_W + 0.3, 0.1, 0.1, COL.mast);
        bt.position.z = 0.2;
        battens.push(bt);
        g.add(bt);
    }
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

// 노꾼 + 노 (우현 기준으로 만들고 좌현은 부모 scale.x = -1 로 미러). 노를 저을 때만 보인다.
const rowerSides: THREE.Group[] = [];
function buildRowerSide(): THREE.Group {
    var side = new THREE.Group();
    for (var i = 0; i < ROWER_Z.length; i++) {
        var z = ROWER_Z[i], u = (z + LEN / 2) / LEN;
        var person = buildPerson(i & 1 ? COL.cloth : COL.clothDark, 0.62);
        person.g.position.set(halfWidth(u) - 0.7, DECK_Y + 0.05, z);
        side.add(person.g);
        // 노: 뱃전 고정점에서 바깥(+X)·아래로. 손잡이는 안쪽 1m.
        var oar = new THREE.Group();
        oar.rotation.order = 'YZX';
        oar.position.set(halfWidth(u), sheerY(u) + 0.05, z);
        var shaft = box(5.0, 0.07, 0.07, COL.mast);
        shaft.position.x = 1.5;
        var blade = box(0.9, 0.04, 0.26, COL.mast);
        blade.position.x = 3.6;
        oar.add(shaft, blade);
        side.add(oar);
        rowers.push({ oar, torso: person.torso, phase: i * 0.15, wasIn: false });
    }
    rowerSides.push(side);
    return side;
}

function buildSteering(): THREE.Group {
    // 선미 중앙 키: 선미판 바깥에 세로로 단 키 기둥 + 물속 키판 + 받침 기둥 위로 뻗은 손잡이.
    var g = new THREE.Group();
    steerOar = new THREE.Group();
    steerOar.position.set(0, DECK_Y, LEN / 2 + 0.12);
    var stock = box(0.16, 3.0, 0.16, COL.mast);
    stock.position.y = -1.0;
    var blade = box(0.08, 1.5, 1.0, COL.mast);
    blade.position.set(0, -1.9, 0.5);
    var tiller = box(0.1, 0.1, LEN / 2 + 0.12 - BITT_Z + 0.4, COL.mast);
    tiller.position.set(0, 0.7, -(LEN / 2 + 0.12 - BITT_Z + 0.4) / 2 + 0.05);
    steerOar.add(stock, blade, tiller);
    g.add(steerOar);
    return g;
}

// 키 받침 기둥 위 등불 — 해 지면 켜진다 (점광원 + 발광 상자)
function buildLantern(): THREE.Group {
    var g = new THREE.Group();
    g.position.set(0.32, DECK_Y + 0.95, BITT_Z);
    lanternMat = mat(0x3a2a1a, { emissive: new THREE.Color(0xffb060), emissiveIntensity: 0 });
    var lamp = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.26, 0.2), lanternMat);
    lanternLight = new THREE.PointLight(0xffb060, 0, 16, 2);
    g.add(lamp, lanternLight);
    return g;
}

function buildStays(): THREE.LineSegments {
    // 돛대 지삭: 꼭대기 → 뱃머리 중앙 / 선미 양 모서리
    var top = [0, DECK_Y + MAST_H - 0.3, MAST_Z], pts: number[] = [];
    var zs = -LEN / 2 + 0.95 * LEN;
    var ends = [[0, sheerY(0), -LEN / 2],
                [halfWidth(0.95) - 0.1, sheerY(0.95), zs], [-(halfWidth(0.95) - 0.1), sheerY(0.95), zs]];
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

    root.add(buildHull(), buildDeck());

    var mast = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.16, MAST_H, 6), mat(COL.mast));
    mast.position.set(0, DECK_Y + MAST_H / 2, MAST_Z);
    var cap = box(0.24, 0.24, 0.24, COL.mast);   // 돛대 꼭대기 도르래 머리
    cap.position.set(0, DECK_Y + MAST_H, MAST_Z);
    var step = box(0.5, 0.5, 0.5, COL.beam);     // 돛대 밑 받침
    step.position.set(0, DECK_Y + 0.25, MAST_Z);
    root.add(mast, cap, step, buildStays());

    sailRig = buildSailRig();
    root.add(sailRig);

    var starboard = buildRowerSide();
    var port = buildRowerSide();
    port.scale.x = -1;
    root.add(starboard, port, buildSteering(), buildLantern());

    // 선미 뒤·위 추적 시점. 높이는 매 프레임 heave 를 따라간다(평행이동만 — 수평선은 안 움직임).
    boatCam.position.set(0, VIEW_HEIGHT_M, chase.back);
    boatCam.rotation.set(CAM_PITCH, 0, 0);
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
        // 활대가 칸마다 돛을 잡아 주므로 배부름은 칸 가운데서 가장 크다
        var pv = v * SAIL_PANELS, panel = Math.sin(Math.PI * (pv - Math.floor(pv)));
        arr[i * 3 + 2] = -fill * Math.sin(Math.PI * xn) * (0.35 + 0.25 * Math.sin(Math.PI * v) + 0.4 * panel)
            + flutter * Math.sin(t * 9 + xn * 7 + v * 3);
    }
    pos.needsUpdate = true;
    sailMesh.geometry.computeBoundingSphere();
    yard.position.y = BOOM_Y + h;
    for (var b = 0; b < battens.length; b++) {
        var bv = (b + 1) / SAIL_PANELS;
        battens[b].position.y = BOOM_Y + h * (1 - bv);
        battens[b].position.z = 0.2 - fill * 0.35 * (0.35 + 0.25 * Math.sin(Math.PI * bv));
    }
}

function updateRowers() {
    rowBlend += (boat.row - rowBlend) * 0.08;
    if (rowBlend > 0.01) rowPhase += 0.15;
    for (var s = 0; s < rowerSides.length; s++) rowerSides[s].visible = rowBlend > 0.02;
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
            _tip.set(3.8, 0, 0);
            r.oar.localToWorld(_tip);   // 씬 좌표 = 파티클 좌표계
            for (var k = 0; k < 4; k++) {
                spawnFoam(_tip.x, seaHeight(_tip.x, _tip.z) + 0.05, _tip.z,
                    (Math.random() - 0.5) * 1.2, 1.2 + Math.random() * 1.2, (Math.random() - 0.5) * 1.2, 0.9, false);
            }
        }
        r.wasIn = isIn;
    }
}

// 항적: 뱃머리에서 Kelvin 각(~19.5°)으로 퍼지는 V + 선체 옆 거품 + 파도에 박힐 때 물보라.
let bowPrev = 0;
function updateWake(v: number) {
    var spread = v * 0.35;
    var n = v > 0.15 ? Math.min(3, v * 0.5) : 0;
    var bowZ = -LEN / 2 + 0.6, bowW = halfWidth(0.05);
    var bowSea = seaHeight(0, bowZ);
    for (var k = 0; k < n; k++) {
        if (Math.random() > n - k) break;
        var side = Math.random() < 0.5 ? -1 : 1;
        spawnFoam(side * bowW, bowSea, bowZ + Math.random() * 1.5,
            side * spread * (0.7 + Math.random() * 0.6), 0, 0, 3 + Math.random() * 2.5, true);
    }
    // 선체 옆 흘수선 거품 (파도가 선체를 칠 때도 조금)
    for (var r = 0; r < 2; r++) {
        if (Math.random() < 0.25 + v * 0.3) {
            var u = 0.15 + Math.random() * 0.7, zs = -LEN / 2 + u * LEN, sd = Math.random() < 0.5 ? -1 : 1, hw = halfWidth(u);
            spawnFoam(sd * hw * 1.02, seaHeight(sd * hw, zs), zs, sd * 0.3, 0, 0, 1.5 + Math.random(), true);
        }
    }
    // 뱃머리가 수면 대비 빠르게 내려가면(파도에 박힘) 물보라 — 속도·파고 비례
    var rel = root.position.y - root.rotation.x * bowZ - bowSea;   // 뱃머리 높이 - 수면
    var dig = bowPrev - rel;
    bowPrev = rel;
    if (dig > 0.02 && v > 0.8) {
        var cnt = Math.min(14, (dig * 80 * v) | 0);
        for (var q = 0; q < cnt; q++) {
            spawnFoam((Math.random() - 0.5) * 2 * bowW, bowSea + 0.2, bowZ - 0.3,
                (Math.random() - 0.5) * 2.5, 2 + Math.random() * 2.5 * Math.min(1, v / 3), -v * 0.3, 1.2, false);
        }
    }
}

// Draw3D 에서 메인 Render3D() 직후 호출.
export function renderBoat3D(renderer: THREE.WebGLRenderer, rig: CelestialRig, camYaw: number, fog: THREE.Fog) {
    if (!built) build();
    var t = wave.time;

    // 대수속력(돛+노)을 실시간 m/s 로 사용 — 물결·항적이 배 속도대로 뒤로 흐른다.
    // 선체 관성: 돛을 내리거나 해안에 막혀도 즉시 멈추지 않고 ~1초(τ) 에 걸쳐 감속.
    speedDisp += (ship.waterMS - speedDisp) * 0.05;
    var v = speedDisp;
    updateLocalSea(v);
    // 흔들림: 선수/선미/좌우 현 수면 높이 → heave·pitch·roll.
    // 관성 smoothing 으로 짧은 잔물결엔 덜 반응. 바람 반대쪽 기울기(heel)는 단동선보다 작게.
    var zb = -LEN / 2 + 1.5, zs = LEN / 2 - 1.5;
    var hb = (seaHeight(-ROLL_X, zb) + seaHeight(ROLL_X, zb)) / 2;
    var hs = (seaHeight(-ROLL_X, zs) + seaHeight(ROLL_X, zs)) / 2;
    var hp = (seaHeight(-ROLL_X, zb) + seaHeight(-ROLL_X, zs)) / 2;
    var hr = (seaHeight(ROLL_X, zb) + seaHeight(ROLL_X, zs)) / 2;
    var rw = relWind();
    var heel = (rw.s >= 0 ? 1 : -1) * 0.03 * sailDisp * Math.min(1.5, wind.speedMS / 8);
    heaveS += ((hb + hs) / 2 - heaveS) * 0.35;
    pitchS += (Math.atan2(hb - hs, zs - zb) - pitchS) * 0.3;
    rollS  += (Math.atan2(hr - hp, 2 * ROLL_X) - rollS) * 0.3;   // +z 회전 = 우현이 올라감
    root.position.y = heaveS;
    boatCam.position.y = VIEW_HEIGHT_M + heaveS;
    boatCam.position.z = chase.back;   // 메인 카메라와 같은 추적 거리 (coords.ts applyCameraToThree 에서 갱신)
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
