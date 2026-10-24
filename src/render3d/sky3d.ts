// sky3d.ts — 그라데이션 스카이돔 + Fog. sky.ts 의 day/dusk/night 팔레트 로직 축약판(RGB 0~1).
import * as THREE from 'three';
import { sun, weather } from '../state';
import { FOG_VIS_THRESHOLD } from '../config';

function lerp(a: number, b: number, t: number) { return a + (b - a) * t; }

// updateSky() 축약: 고도/구름 → (zenith, horizon) RGB 0~1. 대기광 띠/구름 노이즈는 생략(2D 전용).
export function skyPalette(altDeg: number, cloudiness: number) {
    var dayW = (altDeg - 5) / 10;     if (dayW < 0) dayW = 0; else if (dayW > 1) dayW = 1;
    var nightW = (-6 - altDeg) / 6;   if (nightW < 0) nightW = 0; else if (nightW > 1) nightW = 1;
    var duskW = 1 - dayW - nightW;    if (duskW < 0) duskW = 0;
    var DAY_Z = [60, 90, 170], DUSK_Z = [42, 24, 64], NIGHT_Z = [6, 8, 28];
    var DAY_H = [160, 185, 210], DUSK_H = [255, 144, 80], NIGHT_H = [12, 16, 40];
    var zR = (DAY_Z[0]*dayW + DUSK_Z[0]*duskW + NIGHT_Z[0]*nightW) / 255;
    var zG = (DAY_Z[1]*dayW + DUSK_Z[1]*duskW + NIGHT_Z[1]*nightW) / 255;
    var zB = (DAY_Z[2]*dayW + DUSK_Z[2]*duskW + NIGHT_Z[2]*nightW) / 255;
    var hR = (DAY_H[0]*dayW + DUSK_H[0]*duskW + NIGHT_H[0]*nightW) / 255;
    var hG = (DAY_H[1]*dayW + DUSK_H[1]*duskW + NIGHT_H[1]*nightW) / 255;
    var hB = (DAY_H[2]*dayW + DUSK_H[2]*duskW + NIGHT_H[2]*nightW) / 255;
    var cGray = (40 + 160 * dayW + 80 * duskW) / 255;
    var cd = cloudiness * 0.4;
    zR = lerp(zR, cGray, cd); zG = lerp(zG, cGray, cd); zB = lerp(zB, cGray, cd);
    hR = lerp(hR, cGray, cd); hG = lerp(hG, cGray, cd); hB = lerp(hB, cGray, cd);
    // 팔레트 값은 sRGB 기준(2D sky.ts 와 동일) — Color(r,g,b) 생성자는 linear 로 해석해 물빠진 색이 되므로 변환.
    return {
        zenith:  new THREE.Color().setRGB(zR, zG, zB, THREE.SRGBColorSpace),
        horizon: new THREE.Color().setRGB(hR, hG, hB, THREE.SRGBColorSpace),
    };
}

export function buildSkyDome(scene: THREE.Scene): THREE.Mesh {
    var geo = new THREE.SphereGeometry(1900, 24, 16);
    var colors: number[] = [];
    var posAttr = geo.attributes.position;
    for (var i = 0; i < posAttr.count; i++) {
        colors.push(1, 1, 1);
    }
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    var mat = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, fog: false, depthWrite: false });
    var mesh = new THREE.Mesh(geo, mat);
    mesh.renderOrder = -1000;
    scene.add(mesh);
    return mesh;
}

// 저시정 안개색 (2D drawNearFog 와 같은 주간/황혼/야간 분기, sRGB)
const FOG_DAY = new THREE.Color().setRGB(200 / 255, 200 / 255, 205 / 255, THREE.SRGBColorSpace);
const FOG_DUSK = new THREE.Color().setRGB(140 / 255, 130 / 255, 130 / 255, THREE.SRGBColorSpace);
const FOG_NIGHT = new THREE.Color().setRGB(30 / 255, 34 / 255, 44 / 255, THREE.SRGBColorSpace);
const FLASH = new THREE.Color().setRGB(0.95, 0.95, 1.0);
const HAZE_FAR = 250;

// 0(맑음) ~ 1(짙은 안개). 2D 와 같은 임계값(FOG_VIS_THRESHOLD) 아래에서 증가.
export function fogStrength(): number {
    var s = (FOG_VIS_THRESHOLD - weather.visibilityCoef) / 0.5;
    return s < 0 ? 0 : s > 1 ? 1 : s;
}

// 안개: Fog near/far 를 시정에 맞춰 당기고 하늘·지평선색을 안개색으로. flash(0~0.55): 번개.
export function updateSkyDome(mesh: THREE.Mesh, fog: THREE.Fog, flash: number) {
    var pal = skyPalette(sun.altDeg, weather.cloudiness);
    var fs = fogStrength();
    if (fs > 0) {
        var fc = sun.altDeg > 5 ? FOG_DAY : sun.altDeg > -6 ? FOG_DUSK : FOG_NIGHT;
        pal.horizon.lerp(fc, fs);
        pal.zenith.lerp(fc, fs * 0.7);
    }
    if (flash > 0) {
        pal.horizon.lerp(FLASH, flash);
        pal.zenith.lerp(FLASH, flash);
    }
    // 해상 연무: 맑은 날 ~100km 에서 완전히 묻힌다 (scene unit = 400m). 시정 나쁘면 수 km 까지.
    var vis = weather.visibilityCoef;
    fog.far = HAZE_FAR * Math.max(0.012, Math.min(1, vis * vis));
    fog.near = fog.far * 0.04;
    var geo = mesh.geometry as THREE.BufferGeometry;
    var pos = geo.attributes.position as THREE.BufferAttribute;
    var col = geo.attributes.color as THREE.BufferAttribute;
    for (var i = 0; i < pos.count; i++) {
        var y = pos.getY(i);
        var t = (y / 1900 + 1) / 2; // -1(바닥)~1(천정) → 0~1
        if (t < 0) t = 0; else if (t > 1) t = 1;
        var r = lerp(pal.horizon.r, pal.zenith.r, t);
        var g = lerp(pal.horizon.g, pal.zenith.g, t);
        var b = lerp(pal.horizon.b, pal.zenith.b, t);
        col.setXYZ(i, r, g, b);
    }
    col.needsUpdate = true;
    fog.color.copy(pal.horizon);
}
