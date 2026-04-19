// boat-sprite.ts — buf → canvas flip + boat.png 스프라이트.
// Draw 루프 말미(voxel/effects/minimap 이후)에서 호출되어 buf32 결과를 canvas 로 내보낸다.
import { SCR_W, SCR_H } from '../config';
import { ctx, imagedata, buf8 } from '../canvas';
import { boat, wave } from '../state';
import { loadImage } from '../tiles';

// boat.png 를 여기서 소유. main.ts 의 초기 await initBoatSprite() 로 로드.
export const boatSprite: { img: HTMLImageElement | null } = { img: null };

export async function initBoatSprite() {
    boatSprite.img = await loadImage('boat.png');
}

export function DrawBoat() {
    // 파도 흔들림
    var wt = wave.time;
    var bob = Math.sin(boat.gx * wave.swell.dx + boat.gy * wave.swell.dy + wt * wave.swell.speed) * 1.5;

    // Flip: buf → canvas 후 이미지를 ctx 위에 직접 그리기
    imagedata.data.set(buf8);
    ctx.putImageData(imagedata, 0, 0);

    var img = boatSprite.img;
    if (!img) return;
    // 배 위치: 화면 중앙에서 아래쪽 (수평선 밑으로 선체가 내려오도록)
    var BOAT_Y_OFFSET = 78;
    var BOAT_SCALE = 0.89;
    var dw = img.width * BOAT_SCALE, dh = img.height * BOAT_SCALE;
    var sx = (SCR_W - dw) / 2 | 0;
    var sy = (SCR_H - dh) / 2 + BOAT_Y_OFFSET + bob | 0;
    ctx.drawImage(img, 0, 0, img.width, img.height, sx, sy, dw, dh);
}
