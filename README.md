# fask(fast fsk)

브라우저 기반 FSK 송수신 실험 프로젝트입니다.  
`TX` 페이지에서 텍스트를 음성 톤으로 송신하고, `RX` 페이지에서 마이크 입력을 받아 복원합니다.

## 핵심 기능
- `TX`: 프레임 생성 + FSK 송신
- `RX`: 실시간 수신 + 상태머신 디코딩
- V2 프로토콜
  - 헤더 64bit: `PREAMBLE(32) + SYNC(16) + LEN_FLAG(16)`
  - LEN_FLAG 최상위 1비트: 압축 플래그
  - LEN_FLAG 하위 15비트: payload 바이트 길이(0~32767)
- 조건부 압축(`pako`)
  - `rawBytes >= 24`
  - `compressedBytes + 2 < rawBytes` 일 때만 압축 사용
- Ts 프리셋
  - `Safe 120ms`, `Balanced 80ms`, `Fast 60ms`
- RX 디버그 대시보드
  - 레벨 바, 진단 배지, 스펙트럼, `f0/f1` 마커

## 기술 스택
- React 19
- TypeScript
- Vite
- react-router-dom
- pako

## 라우트
- `/tx`: 송신 페이지
- `/rx`: 수신 페이지
- `/`: `/tx`로 리다이렉트

## 사용 방법
1. 브라우저 탭 2개(또는 기기 2대)를 준비합니다.
2. RX 탭에서 `/rx` 진입 후 `Start RX (Mic)` 실행합니다.
3. TX 탭에서 `/tx` 진입 후 텍스트 입력 후 `Send (FSK)` 실행합니다.
4. TX/RX의 Ts 프리셋을 반드시 동일하게 맞춥니다.

## 프로토콜(V2)
프레임 구조:
`[PREAMBLE_32][SYNC_16][LEN_FLAG_16][PAYLOAD_BITS]`

상수:
- `PREAMBLE_BITS_V2 = "01".repeat(16)` (32bit)
- `SYNC_BITS_V2 = "11110000".repeat(2)` (16bit)

LEN_FLAG 인코딩:
- `value = (compressed ? 0x8000 : 0) | payloadByteLength`
- `payloadByteLength` 범위: `0..32767`

## 압축 규칙
압축 후보는 `deflateRaw` 결과를 사용합니다.

압축 사용 조건:
- 원본 바이트 길이 `>= 24`
- `compressedBytes + 2 < rawBytes`

조건 불충족 시 원본(payload raw) 그대로 전송합니다.

RX 복원:
- `compressed=true`면 `inflateRaw` 후 UTF-8 디코딩
- `compressed=false`면 바로 UTF-8 디코딩

## FSK 파라미터
기본 톤:
- `f0 = 1200Hz`
- `f1 = 2200Hz`

Ts 프리셋:
- `safe = 120ms`
- `balanced = 80ms` (기본)
- `fast = 60ms`

예상 전송 시간(대략):
- `총시간 ≈ 전체비트수 * Ts`

## 주의 사항
- 소음 환경에서 수신률이 낮으면 `Fast -> Balanced -> Safe` 순으로 낮춰 테스트하세요.
