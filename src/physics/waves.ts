// waves.ts — swell(너울) ← 해류, mid/ripple ← 바람. 진폭은 풍속 비례.
import { wave, wind, current } from '../state';

export function computeWaves() {
    var K_SWELL = 0.128, K_MID = 0.31, K_RIPPLE = 0.75;
    var windFlow = wind.angleRad + Math.PI;  // 바람이 "부는" 방향
    var curFlow  = current.angleRad;         // 해류 flow direction
    wave.swell.dx  =  Math.sin(curFlow)  * K_SWELL;
    wave.swell.dy  = -Math.cos(curFlow)  * K_SWELL;
    wave.mid.dx    =  Math.sin(windFlow) * K_MID;
    wave.mid.dy    = -Math.cos(windFlow) * K_MID;
    wave.ripple.dx =  Math.sin(windFlow) * K_RIPPLE;
    wave.ripple.dy = -Math.cos(windFlow) * K_RIPPLE;
    var ampF = wind.speedMS / 8;
    if (ampF < 0.2) ampF = 0.2; else if (ampF > 2.0) ampF = 2.0;
    wave.swell.amp  = 2.5 * Math.max(0.5, ampF);
    wave.mid.amp    = 1.2 * ampF;
    wave.ripple.amp = 0.4 * ampF;
}
