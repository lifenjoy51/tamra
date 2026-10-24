// boat-water.ts — 배 뷰모델 씬 전용 "실제 스케일" 국소 바다 + 거품/항적/물보라 파티클.
// 메인 씬 물(water.ts)은 정점 간격 5km·너울 파장 ~20km 라 배 주변 물결을 표현할 수 없다.
// 뷰모델 씬(미터 단위, 배 좌표계)에 80m 패치를 깔고 실제 파장(5~70m)·심해 분산식 ω=√(gk) 파도를 돌린다.
// 가장자리는 vertex alpha 로 녹여 메인 바다와 섞는다. 배 흔들림도 같은 seaHeight() 로 샘플 → 보이는 물결과 일치.
//
// 시간은 게임 배속과 무관한 실시간(프레임당 FRAME_DT) — 120배속으로 물결/항적이 흐르면 알아볼 수 없다.
import * as THREE from 'three';
import { boat, wave, ship } from '../state';
import { terrainHeightM } from '../coast';
import { RENDER_UNIT_M } from '../config';

export const FRAME_DT = 0.05;          // 20fps cap 기준 실시간 초
const G = 9.81;
const PATCH = 84, SEG = 64;            // 패치 한 변(m) / 분할 (정점 간격 ~1.3m)
const PATCH_CZ = -4;                   // 패치 중심 z (카메라가 뒤에 있으니 앞쪽으로 치우침)
const FADE_IN = 16, FADE_OUT = 40;     // 배 중심에서 이 반경 사이 alpha 1 → 0
const WATER_HEX = 0x2a8f8a;            // water.ts 와 같은 색
const WATER_ALPHA = 0.94;              // 중심부 — 잠긴 선체가 아주 살짝 비친다

// 파도 성분: 월드 방향(동=x, 남=y) 단위벡터 + 파수 k + 진폭(m) + 위상
interface Comp { dx: number; dy: number; k: number; amp: number; ph: number; }
const comps: Comp[] = [
    { dx: 0, dy: 0, k: 2 * Math.PI / 70, amp: 0, ph: 0 },   // 너울 (해류 방향)
    { dx: 0, dy: 0, k: 2 * Math.PI / 46, amp: 0, ph: 1.7 }, // 교차 너울 (40° 틀어짐)
    { dx: 0, dy: 0, k: 2 * Math.PI / 18, amp: 0, ph: 0.6 }, // 풍랑 (바람 방향)
    { dx: 0, dy: 0, k: 2 * Math.PI / 5,  amp: 0, ph: 2.9 }, // 잔물결
];

// 물 기준 좌표계에서 배의 누적 이동(m). 배가 앞으로 가면 물결이 뒤로 흘러 이동감이 생긴다.
let ox = 0, oy = 0, rt = 0;
let cosA = 1, sinA = 0;

function setDir(c: Comp, dx: number, dy: number) {
    var l = Math.hypot(dx, dy) || 1;
    c.dx = dx / l; c.dy = dy / l;
}

// 매 프레임: 파도 성분을 wave/wind 상태에서 갱신하고 물 좌표 원점을 전진.
export function updateLocalSea(speedMS: number) {
    rt += FRAME_DT;
    cosA = Math.cos(boat.angle); sinA = Math.sin(boat.angle);
    ox += -sinA * speedMS * FRAME_DT;
    oy += -cosA * speedMS * FRAME_DT;

    var sw = wave.swell, md = wave.mid, rp = wave.ripple;
    setDir(comps[0], sw.dx, sw.dy);
    var c40 = Math.cos(0.7), s40 = Math.sin(0.7);
    setDir(comps[1], sw.dx * c40 - sw.dy * s40, sw.dx * s40 + sw.dy * c40);
    setDir(comps[2], md.dx, md.dy);
    setDir(comps[3], rp.dx, rp.dy);
    // 2D 색 gain 단위 진폭 → m (잔잔 0.2m ~ 강풍 합계 ±1.2m)
    comps[0].amp = sw.amp * 0.11;
    comps[1].amp = sw.amp * 0.05;
    comps[2].amp = md.amp * 0.22;
    comps[3].amp = rp.amp * 0.12;
}

// 배 좌표 (x=우현, z=선미 방향) → 수면 높이(m)
export function seaHeight(x: number, z: number): number {
    // 배 좌표 → 월드(동, 남): 우현 = (cos a, -sin a), 선미 = (sin a, cos a)
    var wx = x * cosA + z * sinA + ox;
    var wy = -x * sinA + z * cosA + oy;
    var h = 0;
    for (var i = 0; i < comps.length; i++) {
        var c = comps[i];
        h += c.amp * Math.sin(c.k * (wx * c.dx + wy * c.dy) - Math.sqrt(G * c.k) * rt + c.ph);
    }
    return h;
}

let alphaOf: Float32Array;

export function buildSeaPatch(): THREE.Mesh {
    var geo = new THREE.PlaneGeometry(PATCH, PATCH, SEG, SEG);
    geo.rotateX(-Math.PI / 2);
    geo.translate(0, 0, PATCH_CZ);
    var pos = geo.attributes.position as THREE.BufferAttribute;
    var col = new Float32Array(pos.count * 4), wc = new THREE.Color(WATER_HEX);
    alphaOf = new Float32Array(pos.count);
    for (var i = 0; i < pos.count; i++) {
        var r = Math.hypot(pos.getX(i), pos.getZ(i) * 0.8);
        var f = (FADE_OUT - r) / (FADE_OUT - FADE_IN);
        f = f < 0 ? 0 : f > 1 ? 1 : f * f * (3 - 2 * f);
        alphaOf[i] = f * WATER_ALPHA;
        col[i * 4] = wc.r; col[i * 4 + 1] = wc.g; col[i * 4 + 2] = wc.b; col[i * 4 + 3] = alphaOf[i];
    }
    geo.setAttribute('color', new THREE.BufferAttribute(col, 4));
    var mat = new THREE.MeshStandardMaterial({
        color: 0xffffff, vertexColors: true, transparent: true,
        roughness: 0.55, metalness: 0.05, flatShading: true, side: THREE.DoubleSide,
    });
    var mesh = new THREE.Mesh(geo, mat);
    mesh.renderOrder = 1;   // 선체(불투명) 다음 — 잠긴 부분을 덮는다
    return mesh;
}

// 배 좌표 (x=우현, z=선미, m) 위치의 지형 높이(m). 바다는 SEA_FLOOR(-5) 근처, 해안선 0.
export function terrainAtBoat(x: number, z: number): number {
    return terrainHeightM(boat.gx + (x * cosA + z * sinA) / RENDER_UNIT_M,
                          boat.gy + (-x * sinA + z * cosA) / RENDER_UNIT_M);
}

// 해안이 이 거리(m) 안이면 패치·파티클을 지형으로 가린다. 이 씬은 메인 렌더 위에 깊이 없이 겹치므로
// 그대로 두면 국소 바다가 해변·절벽 위에 칠해진다.
const LAND_MASK_M = 70;
let masked = false;

export function updateSeaPatch(mesh: THREE.Mesh) {
    var pos = mesh.geometry.attributes.position as THREE.BufferAttribute;
    var col = mesh.geometry.attributes.color as THREE.BufferAttribute;
    var arr = pos.array as Float32Array, carr = col.array as Float32Array;
    var mask = ship.nearLandM < LAND_MASK_M;
    for (var i = 0; i < pos.count; i++) {
        if (alphaOf[i] <= 0) continue;   // 완전 투명 테두리는 갱신 생략
        var x = arr[i * 3], z = arr[i * 3 + 2];
        arr[i * 3 + 1] = seaHeight(x, z);
        if (mask) {
            // 수심 1.2m 보다 얕으면(해안선 쪽) 녹여 없앤다
            var f = (-terrainAtBoat(x, z) - 0.2) / 1.0;
            f = f < 0 ? 0 : f > 1 ? 1 : f;
            carr[i * 4 + 3] = alphaOf[i] * f;
        } else if (masked) carr[i * 4 + 3] = alphaOf[i];
    }
    if (mask || masked) col.needsUpdate = true;
    masked = mask;
    pos.needsUpdate = true;
}

// --- 거품/물보라 파티클 (배 좌표계). 물에 뜬 것(onWater)은 수면을 따라가며 물과 함께 뒤로 흐른다 ---
const MAXP = 700;
const pPos = new Float32Array(MAXP * 3);
const pCol = new Float32Array(MAXP * 4);
const pVel = new Float32Array(MAXP * 3);
const pLife = new Float32Array(MAXP);   // 남은 수명(s), 0 = 비활성
const pMax = new Float32Array(MAXP);
const pWater = new Uint8Array(MAXP);
let pNext = 0;
let foamGeo: THREE.BufferGeometry;

export function buildFoam(): THREE.Points {
    foamGeo = new THREE.BufferGeometry();
    foamGeo.setAttribute('position', new THREE.BufferAttribute(pPos, 3));
    foamGeo.setAttribute('color', new THREE.BufferAttribute(pCol, 4));
    var mat = new THREE.PointsMaterial({
        size: 3, sizeAttenuation: false,   // 화면 px 고정 — 1인칭이라 발밑 거품이 거대 사각형이 되지 않게
        vertexColors: true, transparent: true, depthWrite: false,
    });
    var pts = new THREE.Points(foamGeo, mat);
    pts.frustumCulled = false;
    pts.renderOrder = 2;
    return pts;
}

export function spawnFoam(x: number, y: number, z: number, vx: number, vy: number, vz: number, life: number, onWater: boolean) {
    var i = pNext; pNext = (pNext + 1) % MAXP;
    pPos[i * 3] = x; pPos[i * 3 + 1] = y; pPos[i * 3 + 2] = z;
    pVel[i * 3] = vx; pVel[i * 3 + 1] = vy; pVel[i * 3 + 2] = vz;
    pLife[i] = pMax[i] = life;
    pWater[i] = onWater ? 1 : 0;
}

export function updateFoam(speedMS: number) {
    var dt = FRAME_DT;
    for (var i = 0; i < MAXP; i++) {
        if (pLife[i] <= 0) { pCol[i * 4 + 3] = 0; continue; }
        pLife[i] -= dt;
        var j = i * 3;
        pPos[j] += pVel[j] * dt;
        pPos[j + 2] += (pVel[j + 2] + speedMS) * dt;   // 물과 함께 뒤로
        if (pWater[i]) {
            pVel[j] *= 0.985; pVel[j + 2] *= 0.985;
            pPos[j + 1] = seaHeight(pPos[j], pPos[j + 2]) + 0.06;
        } else {
            pVel[j + 1] -= G * dt;
            pPos[j + 1] += pVel[j + 1] * dt;
            var sea = seaHeight(pPos[j], pPos[j + 2]);
            if (pPos[j + 1] < sea) { pWater[i] = 1; pVel[j + 1] = 0; } // 떨어진 물보라는 거품이 된다
        }
        // 해안에 닿은 거품·물보라는 사라진다 (지형 위에 떠 보이지 않게)
        if (ship.nearLandM < LAND_MASK_M && terrainAtBoat(pPos[j], pPos[j + 2]) > -0.3) { pLife[i] = 0; pCol[i * 4 + 3] = 0; continue; }
        var a = pLife[i] / pMax[i];
        pCol[i * 4] = pCol[i * 4 + 1] = pCol[i * 4 + 2] = 0.95;
        pCol[i * 4 + 3] = a * (pWater[i] ? 0.55 : 0.85);
    }
    foamGeo.attributes.position.needsUpdate = true;
    foamGeo.attributes.color.needsUpdate = true;
}
