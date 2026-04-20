// stars.ts — 항성 테이블 + alt/az 갱신.
// STARS: 1등급~3등급 주요 항성 (Hipparcos 기반).
// updateStars: J2000 + GMST → LST → 시간각 → alt/az, 이후 updatePlanets/updateMoon 호출.
import { sun, timeRef } from '../state';
import { updatePlanets } from './planets';
import { updateMoon } from './moon';

export const STARS = [
    // 1등급 이하 주요 항성
    { ra: 6.752, dec:-16.72, mag:-1.46, n:'Sirius'    },
    { ra: 6.399, dec:-52.70, mag:-0.74, n:'Canopus'   },
    { ra:14.660, dec:-60.83, mag:-0.27, n:'AlphaCen'  },
    { ra:14.261, dec: 19.18, mag:-0.05, n:'Arcturus'  },
    { ra:18.616, dec: 38.78, mag: 0.03, n:'Vega'      },
    { ra: 5.278, dec: 45.99, mag: 0.08, n:'Capella'   },
    { ra: 5.242, dec: -8.20, mag: 0.13, n:'Rigel'     },
    { ra: 7.655, dec:  5.22, mag: 0.38, n:'Procyon'   },
    { ra: 5.919, dec:  7.41, mag: 0.50, n:'Betelgeuse'},
    { ra: 1.629, dec:-57.24, mag: 0.45, n:'Achernar'  },
    { ra:14.064, dec:-60.37, mag: 0.61, n:'Hadar'     },
    { ra:19.846, dec:  8.87, mag: 0.77, n:'Altair'    },
    { ra:12.443, dec:-63.10, mag: 0.77, n:'Acrux'     },
    { ra: 4.599, dec: 16.51, mag: 0.85, n:'Aldebaran' },
    { ra:16.490, dec:-26.43, mag: 1.06, n:'Antares'   },
    { ra:13.420, dec:-11.16, mag: 1.04, n:'Spica'     },
    { ra: 7.755, dec: 28.03, mag: 1.14, n:'Pollux'    },
    { ra: 7.577, dec: 31.89, mag: 1.58, n:'Castor'    },
    { ra:22.961, dec:-29.62, mag: 1.16, n:'Fomalhaut' },
    { ra:20.691, dec: 45.28, mag: 1.25, n:'Deneb'     },
    { ra:12.795, dec:-59.69, mag: 1.25, n:'Mimosa'    },
    { ra:10.140, dec: 11.97, mag: 1.35, n:'Regulus'   },
    { ra: 2.530, dec: 89.26, mag: 1.98, n:'Polaris'   },
    // 오리온
    { ra: 5.679, dec: -1.94, mag: 1.74, n:'Alnitak'   },
    { ra: 5.603, dec: -1.20, mag: 1.69, n:'Alnilam'   },
    { ra: 5.533, dec: -0.30, mag: 2.23, n:'Mintaka'   },
    { ra: 5.796, dec: -9.67, mag: 2.09, n:'Saiph'     },
    { ra: 5.418, dec:  6.35, mag: 1.64, n:'Bellatrix' },
    // 남십자
    { ra:12.519, dec:-57.11, mag: 1.63, n:'Gacrux'    },
    { ra:12.253, dec:-58.75, mag: 2.79, n:'Imai'      },
    // 북두칠성 (큰곰자리 국자 부분)
    { ra:11.062, dec: 61.75, mag: 1.79, n:'Dubhe'     },
    { ra:11.030, dec: 56.38, mag: 2.37, n:'Merak'     },
    { ra:11.897, dec: 53.69, mag: 2.44, n:'Phecda'    },
    { ra:12.257, dec: 57.03, mag: 3.31, n:'Megrez'    },
    { ra:12.900, dec: 55.96, mag: 1.77, n:'Alioth'    },
    { ra:13.399, dec: 54.92, mag: 2.23, n:'Mizar'     },
    { ra:13.792, dec: 49.31, mag: 1.85, n:'Alkaid'    },
    // 카시오페이아 (W자)
    { ra: 0.675, dec: 56.54, mag: 2.24, n:'Schedar'   },
    { ra: 0.153, dec: 59.15, mag: 2.28, n:'Caph'      },
    { ra: 0.945, dec: 60.72, mag: 2.47, n:'GammaCas'  },
    { ra: 1.431, dec: 60.24, mag: 2.68, n:'Ruchbah'   },
    { ra: 1.907, dec: 63.67, mag: 3.38, n:'Segin'     },
    // 백조자리 (북십자)
    { ra:20.370, dec: 40.26, mag: 2.23, n:'Sadr'      },
    { ra:20.770, dec: 33.97, mag: 2.48, n:'GienahCyg' },
    { ra:19.750, dec: 45.13, mag: 2.87, n:'DeltaCyg'  },
    { ra:19.512, dec: 27.96, mag: 3.18, n:'Albireo'   },
    // 전갈자리
    { ra:17.560, dec:-37.10, mag: 1.63, n:'Shaula'    },
    { ra:17.622, dec:-42.99, mag: 1.87, n:'Sargas'    },
    { ra:16.005, dec:-19.80, mag: 2.89, n:'Dschubba'  },
    { ra:16.836, dec:-34.29, mag: 1.86, n:'Epsilon'   },
    // 사자자리
    { ra:11.818, dec: 14.57, mag: 2.11, n:'Denebola'  },
    { ra:10.333, dec: 19.84, mag: 2.08, n:'Algieba'   },
    { ra:11.237, dec: 20.52, mag: 2.56, n:'Zosma'     },
    // 큰개자리 (Sirius 주변)
    { ra: 6.378, dec:-17.96, mag: 1.98, n:'Mirzam'    },
    { ra: 6.977, dec:-28.97, mag: 1.50, n:'Adhara'    },
    { ra: 7.140, dec:-26.39, mag: 1.83, n:'Wezen'     },
    // 독수리자리 (Altair 보조)
    { ra:19.770, dec: 10.61, mag: 2.72, n:'Tarazed'   },
    { ra:19.922, dec:  6.41, mag: 3.71, n:'Alshain'   },
    // 처녀자리 (Spica 주변)
    { ra:13.037, dec: 10.96, mag: 2.85, n:'Vindem'    },
    { ra:12.694, dec: -1.45, mag: 2.74, n:'Porrima'   },
    { ra:12.927, dec:  3.40, mag: 3.38, n:'Auva'      },
    // 고래자리
    { ra: 0.726, dec:-17.99, mag: 2.04, n:'Diphda'    },
    { ra: 3.038, dec:  4.09, mag: 2.53, n:'Menkar'    },
    // 물병자리
    { ra:21.526, dec: -5.57, mag: 2.91, n:'Sadalsuud' },
    { ra:22.096, dec: -0.32, mag: 2.95, n:'Sadalmelik'},
    // 양자리
    { ra: 2.120, dec: 23.46, mag: 2.00, n:'Hamal'     },
    { ra: 1.911, dec: 20.81, mag: 2.64, n:'Sheratan'  },
    // 황소자리 (플레이아데스 포함)
    { ra: 5.438, dec: 28.61, mag: 1.65, n:'Elnath'    },
    { ra: 3.791, dec: 24.11, mag: 2.87, n:'Alcyone'   },
    // 궁수자리 (남쪽 주전자)
    { ra:18.403, dec:-34.38, mag: 1.85, n:'KausAust'  },
    { ra:18.921, dec:-26.30, mag: 2.05, n:'Nunki'     },
    // 마차부자리
    { ra: 5.992, dec: 44.95, mag: 1.90, n:'Menkalinan'},
    // 페가수스자리 (대사각형)
    { ra:23.079, dec: 15.21, mag: 2.49, n:'Markab'    },
    { ra:23.063, dec: 28.08, mag: 2.42, n:'Scheat'    },
    { ra: 0.221, dec: 15.18, mag: 2.83, n:'Algenib'   },
    { ra:21.737, dec:  9.87, mag: 2.40, n:'Enif'      },
    // 안드로메다자리
    { ra: 0.140, dec: 29.09, mag: 2.06, n:'Alpheratz' },
    { ra: 1.162, dec: 35.62, mag: 2.07, n:'Mirach'    },
    { ra: 2.065, dec: 42.33, mag: 2.26, n:'Almach'    },
    // 페르세우스자리
    { ra: 3.405, dec: 49.86, mag: 1.79, n:'Mirfak'    },
    { ra: 3.136, dec: 40.96, mag: 2.12, n:'Algol'     },
    // 왕관자리
    { ra:15.578, dec: 26.71, mag: 2.23, n:'Alphecca'  },
    // 뱀주인자리
    { ra:17.582, dec: 12.56, mag: 2.07, n:'Rasalhague'},
    // 돛자리
    { ra: 9.134, dec:-43.43, mag: 2.21, n:'Suhail'    },
    { ra: 8.745, dec:-54.71, mag: 1.93, n:'Alsephina' },
    // 용골자리
    { ra: 9.220, dec:-69.72, mag: 1.67, n:'Miaplacidus'},
    { ra: 8.375, dec:-59.51, mag: 1.86, n:'Avior'     },
    // 공작자리
    { ra:20.427, dec:-56.74, mag: 1.94, n:'Peacock'   },
    // 쌍둥이 추가
    { ra: 6.628, dec: 16.40, mag: 1.92, n:'Alhena'    },
    // 거문고자리 추가
    { ra:18.982, dec: 32.69, mag: 3.25, n:'Sulafat'   },
    // 작은곰자리 (Polaris 보조)
    { ra:14.845, dec: 74.16, mag: 2.08, n:'Kochab'    },
    { ra:15.345, dec: 71.83, mag: 3.00, n:'Pherkad'   },
    // 용자리
    { ra:17.943, dec: 51.49, mag: 2.24, n:'Eltanin'   },
    { ra:17.507, dec: 52.30, mag: 2.79, n:'Rastaban'  },
    // 케페우스자리
    { ra:21.309, dec: 62.59, mag: 2.46, n:'Alderamin' },
    // 이리자리
    { ra:14.698, dec:-47.39, mag: 2.30, n:'AlphaLup'  },
    { ra:14.975, dec:-43.13, mag: 2.68, n:'BetaLup'   }
];

export const starState = STARS.map(function() { return { altRad: 0, azRad: 0 }; });

// 별 twinkle 위상·주파수 (결정적, 한 번만 초기화)
export const starTwinklePhase = new Float32Array(STARS.length);
export const starTwinkleFreq  = new Float32Array(STARS.length);
(function initTwinkle() {
    for (var i = 0; i < STARS.length; i++) {
        var h = (STARS[i].ra * 73.0 + STARS[i].dec * 31.0);
        starTwinklePhase[i] = (h % (Math.PI * 2));
        starTwinkleFreq[i]  = 1.5 + ((h * 17) % 10) / 10 * 2.5;
    }
})();

export function updateStars() {
    // J2000 = 2000-01-01 12:00 UTC = Unix ms 946728000000. T in days from J2000.
    var Tdays = (timeRef.gameTime / 86400000) - 10957.5;
    var gmst = 18.697374558 + 24.06570982441908 * Tdays;
    var lst = gmst + sun.lon / 15;
    var latRad = sun.lat * Math.PI / 180;
    var sinLat = Math.sin(latRad), cosLat = Math.cos(latRad);
    for (var i = 0; i < STARS.length; i++) {
        var s = STARS[i];
        var decRad = s.dec * Math.PI / 180;
        var H = (lst - s.ra) * 15 * Math.PI / 180;
        var sinDec = Math.sin(decRad), cosDec = Math.cos(decRad);
        var sinH = Math.sin(H), cosH = Math.cos(H);
        var sinAlt = sinLat * sinDec + cosLat * cosDec * cosH;
        if (sinAlt > 1) sinAlt = 1; else if (sinAlt < -1) sinAlt = -1;
        var altRad = Math.asin(sinAlt);
        var azRad = Math.atan2(-cosDec * sinH, sinDec * cosLat - cosDec * sinLat * cosH);
        if (azRad < 0) azRad += 2 * Math.PI;
        starState[i].altRad = altRad;
        starState[i].azRad = azRad;
    }
    updatePlanets(Tdays, gmst, latRad, sun.lon);
    updateMoon(Tdays, gmst, latRad, sun.lon);
}
