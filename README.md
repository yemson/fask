# sound-send (FSK V2)

브라우저에서 텍스트를 FSK 톤으로 송신(TX)하고, 마이크로 수신(RX)하는 실험 프로젝트입니다.
현재 프로토콜은 **V2 고정**입니다.

## 빠른 시작
```bash
pnpm install
pnpm dev
```

- TX: `http://localhost:5173/tx`
- RX: `http://localhost:5173/rx`

## 사용 순서
1. RX 페이지에서 `Start RX`를 누릅니다.
2. TX 페이지에서 텍스트를 입력하고 `Send`를 누릅니다.
3. TX/RX의 Ts 프로파일을 **같게** 맞춥니다.
   - `Safe 120ms` (권장 시작)
   - `Balanced 80ms`
   - `Fast 60ms`

## 프로토콜(V2)
프레임:
`[PREAMBLE_32][SYNC_16][LEN_FLAG_16][PAYLOAD_BITS]`

- `PREAMBLE_BITS_V2 = "01".repeat(16)`
- `SYNC_BITS_V2 = "11110000".repeat(2)`
- LEN_FLAG:
  - 최상위 1비트: compressed flag
  - 하위 15비트: payload byte length (`0..32767`)

압축 규칙:
- 원본 바이트 길이 `>= 24`
- `compressedBytes + 2 < rawBytes` 일 때만 압축

## 트러블슈팅
- 디코딩이 안 될 때
  - Ts를 양쪽 모두 `Safe 120ms`로 맞추고 다시 테스트
  - RX 입력 레벨/진단 배지에서 `Likely FSK`가 나오는지 확인
- `invalid len` / `decode error`가 반복될 때
  - 스피커 볼륨을 올리고 마이크를 더 가깝게
  - 주변 소음을 줄이고 다시 시도
- 탭 전환 후 수신이 불안정할 때
  - RX 탭이 너무 오래 비활성 상태가 되지 않게 테스트
  - 가능하면 창 2개 또는 기기 2대로 테스트

## 스크립트
```bash
pnpm dev
pnpm lint
pnpm test
pnpm build
```
