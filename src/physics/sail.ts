// sail.ts — 돛 polar + AoA 모드 + 선체 ground velocity 합성
import { boat, wind, sail, current, ship, BASE_SAIL_SPEED } from '../state';

// 선수와 바람이 불어오는 방향 사이 각 (0 = 맞바람, π = 순풍).
// boat.angle 은 반시계 증가(π/2 = 서, moveBoat 전진 = (-sin, -cos)), wind.angleRad 는 나침반 방위
// (시계 증가, π/2 = 동) → 선수 방위 = -boat.angle. 두 규약을 그대로 빼면 남북 외 침로에서 판정이 뒤집힌다.
function windAoA(boatAngle: number): number {
    var rel = -boatAngle - wind.angleRad;
    rel = ((rel + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
    return Math.abs(rel);
}

// polar curve (boat.angle 규약 heading) — 디버그/분석 용도로 export
export function polarFor(headingRad: number): number {
    var aoa = windAoA(headingRad);
    if (aoa < Math.PI / 6)        return 0.05;  // IRONS
    else if (aoa < Math.PI / 3)   return 0.55;  // CLOSE
    else if (aoa < 2 * Math.PI / 3) return 1.00;  // BEAM
    else if (aoa < 8 * Math.PI / 9) return 1.20;  // BROAD
    else                          return 0.90;  // RUN
}

// boat.angle vs wind.angleRad 의 AoA → polar·mode·windFactor 업데이트
export function computeSail() {
    var aoa = windAoA(boat.angle);
    if      (aoa < Math.PI / 6)     { sail.polar = 0.05; sail.mode = 'IRONS'; }
    else if (aoa < Math.PI / 3)     { sail.polar = 0.55; sail.mode = 'CLOSE'; }
    else if (aoa < 2 * Math.PI / 3) { sail.polar = 1.00; sail.mode = 'BEAM';  }
    else if (aoa < 8 * Math.PI / 9) { sail.polar = 1.20; sail.mode = 'BROAD'; }
    else                            { sail.polar = 0.90; sail.mode = 'RUN';   }
    var wf = wind.speedMS / 8;
    if (wf < 0.3) wf = 0.3; else if (wf > 1.8) wf = 1.8;
    sail.windFactor = wf;
}

// 선체 속도 합성: 돛 추진 + 해류 drift → ground velocity
export function updateShipSpeed() {
    // boat.sail: 0(접음)/0.5(절반)/1(완전). 면적 비례 추진력 → 선형 scale.
    var sMS = sail.polar * sail.windFactor * BASE_SAIL_SPEED * boat.sail;
    ship.sailMS = sMS;
    // 돛 추진: 선수 방향. boat.angle 0=북 기준 세계좌표 벡터 (-sin, -cos)
    var sVx = -Math.sin(boat.angle) * sMS;
    var sVy = -Math.cos(boat.angle) * sMS;
    // 해류: flow direction (sin, -cos)
    var cVx =  Math.sin(current.angleRad) * current.speedMS;
    var cVy = -Math.cos(current.angleRad) * current.speedMS;
    var vx = sVx + cVx, vy = sVy + cVy;
    ship.groundMS = Math.hypot(vx, vy);
    // 합성 방향 — 세계좌표 벡터 → 표준 방위
    ship.groundDirRad = Math.atan2(vx, -vy);  // 0=북, π/2=동
    if (ship.groundDirRad < 0) ship.groundDirRad += 2 * Math.PI;
}
