# 🎂 생일 파티 사이트

여러 사람이 동시에 들어와 캐릭터로 돌아다니며 채팅하고, 폭죽을 터뜨리고, 방명록을 남기는 실시간 생일 파티 사이트입니다.

- 이름을 입력하고 참가하면 **랜덤 색 캐릭터**가 생성됩니다 (🎲로 색 바꾸기 가능)
- **이동**: 왼쪽 아래 방향키(모바일 터치/마우스) 또는 키보드 방향키·WASD
- **💬 채팅**: 내 캐릭터 머리 위에 말풍선으로 표시 (PC는 Enter로도 열림)
- **🎆 폭죽**: 케이크 양옆 폭죽 근처(점선 원 안)에 가면 버튼이 활성화 → 누르면 모두의 화면에서 폭죽이 터짐 (PC는 Space/F)
- **📜 방명록**: 생일 축하 메시지를 남기고 모두가 실시간으로 확인
- **🎁 선물**: 사진을 고르면 내 캐릭터 발밑에 선물상자가 떨어짐 → 누구나 상자를 눌러 사진을 열어볼 수 있음
  (사진은 브라우저에서 1280px JPEG로 줄여서 올림, 15초에 1개, 전체 최대 30개)

## 🍴 내 생일 파티 사이트 만들기 (Fork 가이드)

이 저장소를 내 GitHub로 복사(Fork)해서 **나만의 생일 파티 사이트**를 무료로 만들 수 있어요.
PC에 아무것도 설치하거나 다운로드할 필요 없이, 웹사이트에서 클릭만으로 끝나요. (약 10분)

> 파티에 **참여만** 하는 친구들은 이 과정이 필요 없어요. 완성된 사이트 링크만 받으면 됩니다.

### 준비물
- GitHub 계정 (https://github.com)
- Render 계정 (https://render.com, GitHub 계정으로 가입하면 편해요)
- Upstash 계정 (https://upstash.com, 선택이지만 권장: 방명록·선물 사진 영구 보관용)

모두 무료이고, 결제 카드를 등록하지 않아도 됩니다.

### 1단계: Fork 하기
1. GitHub에 로그인한 상태로 이 저장소 페이지를 엽니다.
2. 오른쪽 위의 **Fork** 버튼을 누릅니다.
3. **Owner**가 내 계정인지 확인하고, 저장소 이름은 그대로 두거나 원하는 이름으로 바꿉니다.
4. **Create fork**를 누르면 `https://github.com/내아이디/저장소이름`에 내 복사본이 생깁니다.

### 2단계: (권장) Upstash 데이터베이스 만들기
방명록과 선물 사진이 서버 재시작 후에도 남도록 저장소를 만들어요.

1. https://console.upstash.com 로그인 → **Redis** → **Create Database**
2. Name은 자유롭게, Region은 **US West (Oregon)** 근처, Plan은 **Free** 선택 → **Create**
3. 생성된 데이터베이스 화면 아래 **REST API** 영역의 **`.env`** 탭에서 두 값을 복사해 둡니다.
   - `UPSTASH_REDIS_REST_URL`
   - `UPSTASH_REDIS_REST_TOKEN`

### 3단계: Render로 배포하기
1. https://dashboard.render.com 로그인 → **New +** → **Blueprint**
2. GitHub 연결을 허용하고, 1단계에서 만든 **내 Fork 저장소**를 선택합니다.
   (목록에 안 보이면 **Configure account**에서 Render가 이 저장소에 접근하도록 허용하세요.)
3. 환경 변수 입력 칸이 나오면 채웁니다.
   - `ADMIN_KEY`: 관리자 비밀번호 (영문·숫자·기호 섞어서 12자 이상 권장)
   - `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`: 2단계에서 복사한 값 (건너뛰었다면 비워 둠)
4. **Apply**를 누르고 1~2분 기다리면 `https://hbd-party-xxxx.onrender.com` 같은 주소가 생깁니다.

### 4단계: 주인공 이름 바꾸기
1. 내 사이트 주소 뒤에 `/admin`을 붙여 접속합니다. 예: `https://hbd-party-xxxx.onrender.com/admin`
2. `ADMIN_KEY`로 정한 비밀번호를 입력합니다.
3. **🎂 주인공 이름**에 생일인 사람 이름을 넣고 **저장**하면 끝!

이제 사이트 주소를 친구들에게 공유하세요. 🎉

### 원본이 업데이트되면 (선택)
원본 저장소에 새 기능이 추가되면 내 Fork에도 가져올 수 있어요.

1. 내 Fork 저장소 페이지에서 **Sync fork** → **Update branch**를 누릅니다.
2. Render가 자동으로 다시 배포합니다. 방명록·선물·주인공 이름은 Upstash에 있어서 그대로 유지돼요.

### 알아 두세요
- 내 사이트의 방명록·선물 사진은 **내 Upstash에만** 저장되어, 원본이나 다른 친구의 사이트와 섞이지 않아요.
- 공개 저장소를 Fork하면 내 Fork도 공개됩니다. 비밀번호나 토큰은 **절대 코드에 쓰지 말고** Render의 Environment에만 넣으세요.
- Render 무료 서버는 15분 동안 접속이 없으면 잠들고, 깨어나는 데 30초~1분이 걸려요. 파티 직전에 한 번 접속해 두세요.

## 로컬 실행

Node.js 18 이상이 필요합니다.

```bash
npm install
npm start
```

브라우저에서 http://localhost:3000 접속. 여러 탭을 열면 멀티플레이를 확인할 수 있습니다.

## 설정 (환경 변수)

| 이름 | 설명 |
| --- | --- |
| `BIRTHDAY_NAME` | 생일 주인공 이름의 기본값. `/admin`에서 이름을 바꾸면 그 값이 우선 |
| `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` | 방명록·선물·설정 영구 저장용 (선택, 아래 참고) |
| `ADMIN_KEY` | 관리자 비밀번호. `/admin` 페이지(주인공 이름, 금지어, 선물·방명록 삭제) 로그인용 |
| `MAX_PLAYERS` | 동시 접속 최대 인원. 기본값 50 |
| `MAX_GIFTS` | 맵에 놓을 수 있는 선물상자 최대 개수. 기본값 30 |

## 무료 배포 (Render)

1. 이 폴더를 GitHub 저장소에 올립니다.
2. https://render.com 가입 → **New + → Blueprint** → 저장소 선택  
   (`render.yaml`이 있어서 설정이 자동으로 채워집니다. 직접 만들려면 **New + → Web Service**, Build `npm install`, Start `npm start`, 플랜 Free)
3. 환경 변수 `BIRTHDAY_NAME`에 주인공 이름을 넣고 배포합니다.
4. 발급된 `https://hbd-party-xxxx.onrender.com` 주소를 친구들에게 공유하면 끝!

> Render 무료 플랜은 15분 동안 접속이 없으면 잠들고, 다음 접속 때 깨어나는 데 30초~1분 정도 걸립니다.
> 파티 시작 전에 미리 한 번 접속해 두세요.

### 방명록을 영구 보관하려면 (권장)

Render 무료 플랜은 서버가 잠들거나 재배포될 때 파일이 초기화되어 **방명록이 사라질 수 있습니다.**
무료 Upstash Redis를 연결하면 안전하게 보관됩니다.

1. https://upstash.com 가입 → **Create Database** (Redis, 무료)
2. 데이터베이스 화면의 **REST API** 섹션에서 `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` 복사
3. Render 서비스의 **Environment**에 두 값을 추가하고 저장 (자동 재배포)

서버 로그에 `[guestbook] Upstash Redis에서 N개 불러옴`이 나오면 연결된 것입니다.

## 관리자 페이지 (/admin)

1. Render 서비스의 **Environment**에 `ADMIN_KEY`(관리자 비밀번호)를 추가합니다.
2. 사이트 주소 뒤에 `/admin`을 붙여 접속합니다. 예: `https://hbd-party-xxxx.onrender.com/admin`
3. 비밀번호를 입력하면 관리 화면이 나옵니다.
   - **🎂 주인공 이름**: 바꾸고 저장하면 케이크·제목에 바로 반영되고 저장소에 보관됩니다 (재시작해도 유지).
   - **🚫 금지어**: 이름에 들어 있으면 참가를 막고, 채팅·방명록에서는 ***로 가립니다. 띄어쓰기·숫자·기호를 끼운 변형(예: `시 1 발`)도 잡습니다. 처음에는 기본 목록이 들어 있고 자유롭게 추가·삭제할 수 있습니다.
   - **🎁 선물 사진**: 올라온 사진을 미리 보고 🗑로 지울 수 있습니다.
   - **📜 방명록**: 글마다 있는 🗑 삭제 버튼으로 지우면 저장소와 모든 사람 화면에서 바로 사라집니다.

일반 파티 화면에는 관리자 버튼이 보이지 않습니다. 비밀번호를 5번 틀리면 1분 동안 잠깁니다.
관리자 로그인 시 저장소(Upstash)를 다시 읽어 오므로, Upstash 화면에서 직접 고친 내용도 이때 반영됩니다.

## 파일 구조

```
server.js          실시간 서버 (Express + Socket.IO)
storage.js         방명록·선물·설정 저장 (파일 또는 Upstash Redis)
filter.js          금지어 필터
public/
  index.html       화면 구성 (참가 화면, HUD, 방명록)
  admin.html       관리자 페이지 (/admin): 주인공 이름, 선물 사진·방명록 삭제
  style.css        스타일
  game.js          맵·캐릭터·폭죽 그리기, 이동, 채팅, 방명록
  world.js         맵 배치·충돌 (서버와 공용)
render.yaml        Render 배포 설정
```
