// wind.ts — Hadley/Ferrel/Polar + ITCZ + 아시아 몬순 + 결정적 noise
import { wind, sun } from '../state';

// --- 지역·계절·시간별 바람 (대기 대순환 근사) ---
export function computeWind() {
    var lat = sun.lat, lon = sun.lon;
    var day = sun.dayOfYear, hr = sun.hourLocal;

    // 계절별 위도대 shift (여름 +5°, 겨울 -5°)
    var shift = 5 * Math.sin(2 * Math.PI * (day - 81) / 365);
    var eff = lat - shift;
    var a = Math.abs(eff);

    var dir, spd;
    if (a < 5)        { dir = eff > 0 ? 45 : 135;   spd = 2;  }   // ITCZ
    else if (a < 30)  { dir = eff > 0 ? 45 : 135;   spd = 8;  }   // 무역풍
    else if (a < 35)  { dir = eff > 0 ? 135 : 45;   spd = 3;  }   // 말 위도
    else if (a < 60)  { dir = eff > 0 ? 225 : 315;  spd = 12; }   // 편서풍
    else              { dir = eff > 0 ? 45 : 135;   spd = 5;  }   // 극동풍

    // 아시아 몬순 (Indian Ocean / SE Asia)
    if (lon > 60 && lon < 150 && lat > -20 && lat < 30) {
        if (day > 120 && day < 270)     { dir = 225; spd = 10; } // SW 몬순
        else if (day > 300 || day < 60) { dir = 45;  spd = 8;  } // NE 몬순
    }

    // 해륙풍 근사 (낮/밤 약한 sin 변조)
    var night = Math.sin(2 * Math.PI * hr / 24);
    dir += night * 8;
    spd *= 1 + night * 0.1;

    // 결정적 noise (위치 0.2° + 주 단위 + 년도)
    var seed = (Math.floor(lat * 5) + Math.floor(lon * 5) * 7 + Math.floor(day / 7) * 13 + sun.year * 31) >>> 0;
    var n = ((seed * 2654435761) >>> 0) / 4294967295;
    dir += (n - 0.5) * 30;
    spd *= 0.7 + n * 0.6;

    dir = ((dir % 360) + 360) % 360;
    if (spd < 0) spd = 0;

    wind.angleRad = dir * Math.PI / 180;
    wind.speedMS = spd;
}
