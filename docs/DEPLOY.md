# 배포 가이드

Oracle Cloud Ubuntu 인스턴스 + Caddy(자동 HTTPS) 서브패스 배포 기준. 다른 환경도 원리는 동일 — `release/tamra/` 디렉토리를 정적 서빙하고, 빌드 시 `VITE_BASE` 를 해당 서브패스로 지정하면 된다.

## 1. 로컬에서 번들 만들기

첫 배포나 타일 파이프라인이 바뀌었을 때:

```bash
npm run release:tile:zip
# → release/tamra-tile.zip (약 207MB, WebP 타일 8,496개 포함)
```

- 첫 실행 약 15초 (tiles 복사 6초 + zip 9초)
- 이후 실행 약 9~10초 (rsync 증분 + zip)
- 서브패스 변경 시 `package.json` 의 `release` 스크립트에서 `VITE_BASE=/tamra/` 값 교체

## 2. 서버로 업로드

```bash
# 예시: Oracle Cloud 인스턴스
scp -i ~/works/ssh-key-2026-04-04.key \
    release/tamra-tile.zip \
    ubuntu@168.107.59.45:~/
```

## 3. 서버에서 압축 해제

```bash
ssh -i ~/works/ssh-key-2026-04-04.key ubuntu@168.107.59.45

# 원격 셸에서 — 전체 번들(타일 포함)을 처음 풀 때
sudo rm -rf /var/www/tamra
sudo unzip -q ~/tamra-tile.zip -d /var/www/
sudo chown -R caddy:caddy /var/www/tamra
rm ~/tamra-tile.zip
ls /var/www/tamra
# 확인: index.html · assets/ · boat.png · tiles/ 가 있어야 함
```

## 4. Caddyfile 설정

기존 도메인 블록에 `/tamra/*` 핸들러를 추가한다. 예시:

```caddyfile
lifenjoy51.duckdns.org {
    # /tamra/* → /home/ubuntu/tamra 정적 서빙
    handle_path /tamra/* {
        root * /home/ubuntu/tamra
        file_server
        encode gzip
        # heightmap 타일은 immutable (파일명 불변)
        @tile path_regexp ^/tiles/h_
        header @tile Cache-Control "public, max-age=31536000, immutable"
        # 해시 붙은 번들도 immutable
        @asset path /assets/*
        header @asset Cache-Control "public, max-age=31536000, immutable"
        # index.html 은 항상 최신
        header /index.html Cache-Control "no-cache"
    }

    # 나머지 경로는 기존 서비스
    handle {
        reverse_proxy 127.0.0.1:8840
    }
}
```

### 핵심 포인트

- **`handle_path /tamra/*`** — `/tamra` 접두사를 자동으로 **제거**하고 매칭. 브라우저가 요청한 `/tamra/assets/index-xxx.js` → Caddy가 `/assets/index-xxx.js` 로 변환 → `/home/ubuntu/tamra/assets/index-xxx.js` 에서 읽음. Vite 가 `VITE_BASE=/tamra/` 로 빌드한 HTML 의 `/tamra/assets/...` 참조와 정확히 맞물린다.
- **`handle` (인자 없음)** — 위 `handle_path` 에 매칭되지 않은 나머지 경로를 처리. 기존 서비스가 있으면 여기에 둔다.
- **`encode gzip`** — Caddy 는 `text/*`, `application/json`, `application/javascript` 등만 자동 압축. WebP/PNG 같은 이미 압축된 바이너리는 스킵하므로 안전하다.
- **Cache-Control immutable** — 타일(`h_*.webp`) 과 번들(`assets/*`) 은 파일명·해시가 불변이므로 1년 캐시. `index.html` 은 `no-cache` 로 두어 배포 즉시 반영.

## 5. 적용

```bash
sudo caddy fmt --overwrite /etc/caddy/Caddyfile
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

문제 발생 시: `sudo journalctl -u caddy -n 50`

## 6. 확인

```bash
# 브라우저
https://lifenjoy51.duckdns.org/tamra/

# 압축 여부 확인 (JS 는 gzip, WebP 는 raw)
curl -sI -H 'Accept-Encoding: gzip,br' \
  https://lifenjoy51.duckdns.org/tamra/assets/index-xxx.js | grep -i encoding
# → content-encoding: gzip

curl -sI -H 'Accept-Encoding: gzip,br' \
  https://lifenjoy51.duckdns.org/tamra/tiles/h_143_27.webp | grep -i encoding
# → (없음)
```

## 재배포 (코드만, tiles 유지)

평상시엔 `release:zip` 이 기본 — tiles 는 불변이라 번들에서 제외된다 (**~63KB**). 업로드·해제 둘 다 즉시.

```bash
# 로컬
npm run release:zip
scp -i ~/works/ssh-key-2026-04-04.key release/tamra.zip ubuntu@168.107.59.45:~/

# 원격 — unzip -o 로 덮어쓰기, tiles/h_*.webp 는 그대로 유지
ssh -i ~/works/ssh-key-2026-04-04.key ubuntu@168.107.59.45 <<'EOF'
sudo unzip -q -o ~/tamra.zip -d /var/www/
sudo chown -R caddy:caddy /var/www/tamra
rm ~/tamra.zip
EOF
# Caddy 는 파일 변경만으로도 자동 반영 — reload 불필요
```

## 전체 재배포 (tiles 포함)

타일이 바뀐 경우에만. 용량 커서 오래 걸림.

```bash
npm run release:tile:zip
scp -i ~/works/ssh-key-2026-04-04.key release/tamra-tile.zip ubuntu@168.107.59.45:~/

ssh -i ~/works/ssh-key-2026-04-04.key ubuntu@168.107.59.45 <<'EOF'
sudo rm -rf /var/www/tamra
sudo unzip -q ~/tamra-tile.zip -d /var/www/
sudo chown -R caddy:caddy /var/www/tamra
rm ~/tamra-tile.zip
EOF
```

## 방화벽 (Oracle Cloud)

포트 80/443 이 이미 열려있는 걸 가정. 신규 포트 필요 시:

```bash
# 인스턴스 내부 (Ubuntu iptables)
sudo iptables -I INPUT -p tcp --dport 80 -j ACCEPT
sudo netfilter-persistent save
```

**그리고** Oracle Cloud Console → 네트워킹 → VCN → 서브넷 → 보안 목록 에서 인그레스 규칙 추가. 이게 없으면 인스턴스 내부 iptables 만 열어도 외부 연결 안 됨.
