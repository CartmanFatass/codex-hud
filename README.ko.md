> 이 한국어 문서는 [현재 소스 후보 `e862d759`](https://github.com/CartmanFatass/codex-hud/commit/e862d75914b6ab36f36161fe19b346dac34681e4)의 개요입니다. 상세 참조 링크는 영어 문서로 연결됩니다. 개발 후보이며 릴리스나 모든 기능·환경의 검증 완료를 뜻하지 않습니다. [기존 hosted CI](https://github.com/CartmanFatass/codex-hud/actions/runs/42259248264)가 성공했어도 새 `statusline-native-details` 전용 테스트는 컴파일만 되었고 **NOT_RUN**이며 새 모드의 로컬 실행·live-client·시각·성능 검증도 **NOT_RUN**입니다.

<p align="center">
  <a href="./README.md"><img src="https://img.shields.io/badge/lang-English-blue.svg" alt="English"></a>
  <a href="./README.zh.md"><img src="https://img.shields.io/badge/lang-中文-red.svg" alt="中文"></a>
  <a href="./README.ja.md"><img src="https://img.shields.io/badge/lang-日本語-green.svg" alt="日本語"></a>
  <a href="./README.ko.md"><img src="https://img.shields.io/badge/lang-한국어-orange.svg" alt="한국어"></a>
</p>

# Codex HUD

[OpenAI Codex CLI](https://github.com/openai/codex)를 위한 실시간 상태 표시줄 HUD. 경량, 무설정, tmux 내 동작.

> Claude Code의 [claude-hud](https://github.com/jarrodwatts/claude-hud)에서 영감을 받았습니다.

![Codex HUD — 단일 세션](./docs/fig/bar.png)

## 왜 Codex HUD가 필요한가요?

**Q: Codex CLI만으로 충분하지 않나요?**

계기판 없이 비행하는 것과 같습니다. Codex HUD는 터미널 하단에 상시 대시보드를 제공합니다:

- **브랜치, 모델, 권한** — 한눈에 파악, 추측 불필요
- **Token 사용량 (cache 포함)** — 컨텍스트 소비량을 정확히 파악
- **Context 윈도우 채움 바** — 한계에 가까워지면 즉시 인지
- **MCP 서버 상태 & 도구 호출** — Codex가 실제로 무엇을 하는지 모니터링
- **Reasoning effort 레벨** — 현재 사고 깊이 표시

**Q: 세션이 서브에이전트를 생성합니다. 무엇을 하는지 볼 수 있나요?**

네. `F12`는 Codex에 포커스를 둔 채 오른쪽 서브에이전트 패널을 열고 닫으며 `Shift+F12`는 패널을 열고 포커스를 옮깁니다. 바와 패널은 번갈아 표시되며 패널이 열려 있으면 바의 정보가 footer/status card로 이동합니다. 관측된 에이전트의 모델·추론 강도·상태·부모 관계를 확인할 수 있습니다.

`Ctrl+T`는 의도적으로 비워 두었습니다. Codex 자체의 트랜스크립트 오버레이용입니다.

![Codex HUD — 서브에이전트 트리](./docs/fig/panel.png)

**Q: tmux를 수동으로 설정해야 하나요?**

tmux를 수동 설정할 필요 없이 Codex HUD가 실행합니다. 기존 Codex 설정에서는 `codex`로 HUD를 열 수 있습니다. Bash 설치 프로그램은 대화형 터미널에서만 tmux 자동 설치를 제안합니다. 전제 조건이 없거나 비대화형 실행이 실패하면 표시된 수동 절차를 따라야 합니다.

## 빠른 시작

다음은 기존 Codex 설정 절차입니다. 뒤에 소개하는 모든 CLI 기능을 설치하는 절차가 아닙니다.

```bash
git clone https://github.com/CartmanFatass/codex-hud.git
cd codex-hud
./bin/codex-hud-install

# 셸을 새로고침한 후 입력:
codex
```

<details>
<summary><b>Windows (WSL 기본값)</b>: 설치, self-check, PowerShell / cmd 명령어</summary>

Windows의 HUD runtime은 WSL입니다. PowerShell과 cmd는 실행기로 사용하고 HUD 자체는 Ubuntu WSL의 Bash + tmux에서 동작합니다. **이 Windows 설치 절차는 네이티브 Windows 호스트에서 검증되지 않았습니다. 사용 전에 기존 Codex 설정을 백업하세요.** 아래 기존 스크린샷은 이 후보의 새로운 검증 결과가 아닙니다.

1. 기존 Codex 설정을 내려받고 설치 프로그램을 실행합니다:

```powershell
git clone https://github.com/CartmanFatass/codex-hud.git
cd codex-hud
.\bin\codex-hud-install.ps1
```

2. 새 PowerShell 또는 cmd 창을 열고 WSL runtime을 확인합니다:

```powershell
codex --self-check
```

![Windows WSL self-check](./docs/fig/wsl-self-check.png)

3. Codex HUD를 실행합니다:

```powershell
codex
```

![Windows WSL launch](./docs/fig/windows-wsl.png)

Notes:

- `codex`는 Windows에서 기본적으로 WSL HUD를 실행합니다.
- `codex --wsl ...`은 같은 WSL HUD 경로를 명시적으로 선택하며, Codex CLI로 전달하기 전에 wrapper 인수를 제거합니다.
- native PowerShell HUD는 현재 사용자 실행 모드로 지원되지 않습니다. legacy native-mode request는 fail fast 하며 WSL HUD 사용을 안내합니다.
- `codex-hud-wsl`은 Ubuntu WSL에서 전체 HUD를 실행하는 명시적 명령입니다.
- `cmd.exe` 사용자는 동일한 PowerShell entrypoint를 호출하는 관리형 `.cmd` shim을 받습니다.

**관리 명령어**

첫 설치 후 다음 명령어가 셸에 추가됩니다:

| 명령어 | 설명 |
|--------|------|
| `codex-hud-sync` | 현재 체크아웃을 다시 빌드하고 별칭 갱신 |
| `codex-hud-upgrade` | 최신 변경 사항을 풀한 후 다시 빌드 |
| `codex-hud-uninstall` | 별칭을 제거하고 HUD 세션 중지 |

</details>

## HUD에 무엇이 표시되나요?

아래는 기존 **Codex 바**의 합성·설명용 한 줄 예제입니다. Claude의 `hud statusline` 출력 예제가 아닙니다.

```text
gpt-5.6-astra xhigh │ 152.3K/272K │ synthetic-project main │ ✓ idle
```

모델·reasoning effort, Codex가 보고한 마지막 요청의 context 사용량/용량, 저장소·브랜치, 상태를 보여줍니다. 너비와 density, 관측된 데이터에 따라 quota, 속도, agents, plan, 알림 등이 추가됩니다. 관측값이 없으면 항목을 생략하거나 `unknown`(알 수 없음)으로 남기며 0이나 추정값으로 채우지 않습니다. 현재 카드·compact 보기는 [workbench(영어)](./README.md#development-workbench), 조작 방법은 [키 목록(영어)](./docs/reference.md#keys)을 참고하세요.

## 사용법

```bash
codex                        # HUD와 함께 실행
codex --model gpt-5          # Codex CLI 인수 전달
codex "help me debug this"   # 프롬프트 포함
codex-resume                 # 이전 세션 재개
```

<details>
<summary>추가 명령어</summary>

```bash
codex-hud --kill             # 현재 디렉토리의 세션 종료
codex-hud --list             # 모든 HUD 세션 목록
codex-hud --attach           # 기존 세션에 연결
codex-hud --new-session      # 새 세션 강제 생성
codex-hud --self-check       # 환경 진단 실행
```

</details>

## 현재의 명시적 CLI 진입점

아래 진입점은 위의 Codex/tmux 설정과 별개입니다. 이 개발 후보가 포함된, 검토 대상 테스트 브랜치의 완전한 체크아웃이 필요합니다. 기본 브랜치를 clone했다고 해서 후보 기능이 포함되어 있다고 볼 수는 없습니다. 개발에는 Node 22.x >=22.13 또는 Node 24를 사용합니다. 실제 universal wrapper는 Node 22.x >=22.13 또는 >=24를 허용하며 23은 거부합니다. `package.json`의 오래된 `>=18` 표기와 Codex 호환 경로는 ledger 명령의 Node 18/20 지원 근거가 아닙니다.

저장소 안에서는 `node bin/hud ...`를 사용합니다. `npm run build`는 명령을 설치하지 않습니다. 설치되어 있다면 `hud`가 동등한 진입점이고 `hud-statusline`은 statusline 전용 진입점입니다. `hud-statusline-preview`는 별도의 compact 전용 미리보기입니다. 아래 ID와 절대 경로는 설명용 자리표시자이며 실행 성공 기록이 아닙니다.

| 명령 | 용도와 제한 |
| --- | --- |
| `node bin/hud --help` | 현재 라우팅을 확인합니다. 빌드나 설치 작업이 아닙니다. |
| `node bin/hud codex [ARG ...]` | 기존 Codex 호환 실행기입니다. 위의 `codex` 명령도 계속 사용할 수 있습니다. |
| `node bin/hud panel` / `node bin/hud panel --help` | 현재 터미널에 위임 패널을 엽니다. 가능하면 범위가 제한된 관측 worker를 사용하고, 사용할 수 없으면 읽기 전용 관측을 표시합니다. source/profile 선택 인수는 없습니다. |
| `node bin/hud statusline --details --lang en --width 80` | stdin의 Claude 네이티브 정보를 상세 표시합니다. 아래 합성 예제를 참고하세요. |
| `node bin/hud pi inspect --source /synthetic/pi --session /synthetic/pi/session.jsonl --json` | 기존 파일만 관측합니다. 실행, 전체 transcript 내보내기, identity/control 권한 부여는 하지 않습니다. |
| `node bin/hud pi launch --executable /absolute/path/to/pi -- -e /absolute/path/to/codex-hud/extensions/pi/hud-footer.ts` | Pi를 명시적으로 로컬 foreground에서 실행하고 선택적 footer를 로드합니다. 관리형 위임은 아닙니다. |
| `node bin/hud claude --help` | profile 기반 실행 구문을 확인합니다. 이 후보에 포함된 검토 완료 launch/resume capability cells는 비어 있으며 실행 성공을 보장하지 않습니다. |
| `node bin/hud run --help` | `status` / `cancel` / `reconcile` / `resume` / `wait`. 읽기 예제는 `node bin/hud run status synthetic-run --json`입니다. 다른 인수는 help에서 확인하세요. |
| `node bin/hud cache show --json` | cache v2 설정 스냅샷과 조언을 읽습니다. 세션 데이터나 digest 캐시가 아닙니다. |
| `node bin/hud link export --json --schema-version 1` | 읽기 전용 메타데이터 출력입니다. 로컬 경로는 명시적 `--paths local`에서만 포함하며 `--link ID`를 반복할 수 있습니다. 출력 파일을 자동 저장하지 않습니다. |
| `node bin/hud migrate --help` | Linux 전용 명시적 표시 설정 이전입니다. `codex-display-v1`로 기존 private source/target을 선택하고 preview 후 입력 digest에 결합된 apply를 수행합니다. 자격 증명, material/outbound grants, 캐시는 복사하지 않습니다. |
| `node bin/hud digest --help` | 완료 보고서 한 건을 수동으로 요약합니다. 아래 허용 범위를 참고하세요. |

ledger를 사용하는 작업에는 절대·canonical·private·동일 uid 소유의 기존 `HUD_HOME`과 호환 store가 필요합니다. 이 예제들은 초기화하지 않습니다. stdin 네이티브 렌더링이나 `pi inspect --source`에는 보통 ledger가 필요 없습니다. `cancel` 접수는 종료의 증거가 아니며 visible run의 cancel은 signal을 보낼 수 없습니다. `resume`에는 검증된 capability 증거가 필요합니다. `wait` 기한 도달은 cancel이 아닙니다. 이전 작업은 [정확한 절차(영어)](./docs/cloud-development/reversible-migration.md#preview-review-apply-select-restore)를 확인하세요.

### Claude statusline: compact와 명시적 details

합성 입력 예제이며 실제 실행 결과를 캡처한 것이 아닙니다.

```sh
printf '%s' '{"model":{"display_name":"Claude"},"context_window":{"used_percentage":42},"cost":{"total_cost_usd":0.12}}' | node bin/hud statusline --details --lang en --width 80
```

설명용 예상 첫 줄은 `model Claude · ctx [####------] 42% · cost $0.12`입니다. `--details`와 `--lang`을 모두 생략하면 기존 compact 출력 `Claude · ctx 42% · $0.12`를 유지합니다. `--lang`은 `--details`가 필요하며 `en`(기본값) 또는 `zh`만 지원합니다. `--lang zh`를 선택할 수 있지만 `--lang ja` / `--lang ko`, 자동 언어 선택, `=` 형식, 언어 설정 저장은 없습니다. 중복이나 잘못된 구문은 거부합니다. `hud-statusline-preview`는 새 스위치를 받지 않습니다. 이 번역이 runtime 한국어 지원을 추가하는 것은 아닙니다.

- 입력은 UTF-8 JSON 객체 하나이며 최대 64 KiB입니다. 1초 입력 가드는 응답 시간 보장이 아닙니다. 너비는 1–500이고 `--width`, 유효한 `COLUMNS`, 유효한 TTY 너비, 80 순서로 선택합니다. 좁아지면 선택적 정보를 먼저 제거하고 마지막에 모델 이름을 자릅니다. 일반적인 입력·인수 진단은 원시 입력을 출력하지 않습니다.
- 제공된 모델, 사용률·잔여율, 추정 세션 USD, 디렉토리, 입출력·window·cache 개수, 밀리초 단위 시간, 추가·삭제 행 수를 표시할 수 있습니다. 누락되거나 잘못된 값의 구간은 생략하고 유효한 0은 유지합니다. 잔여율은 독립된 값이며 `100-used`로 계산하지 않습니다. 디렉토리는 표시 문자열일 뿐 source 권한이 아닙니다. 비용은 청구액·잔액·quota가 아닙니다. [필드 의미(영어)](./docs/statusline/native-details.md#admitted-facts-and-absence)를 참고하세요.
- 네이티브 Git/PR 조회, effort/quota, tools/Todos, 속도, toktrack tee, 추정 합계, 별도 upstream `subagentStatusLine`은 지원 범위 밖입니다. renderer가 순수 함수라고 해서 제품 명령 전체가 파일시스템을 사용하지 않는 것은 아닙니다.
- 명시적 `--source ABSOLUTE_CLAUDE_ROOT` 또는 `CLAUDE_CONFIG_DIR`와 호환 ledger가 있으면 기존의 범위 제한·읽기 전용 공유 summary/fallback을 사용할 수 있습니다. 선택적 둘째 줄은 항상 직접 자식에 대한 `partial`(부분 증거)이며 전체 트리 합계가 아닙니다. transcript를 수집하지 않고 `cwd` / `transcript_path`에서 source를 추정하지 않습니다. 증거가 없으면 첫 줄을 유지합니다. 언어 선택은 네이티브 첫 줄에만 적용됩니다. [summary 의미와 예산·검증 경계(영어)](./docs/statusline/delegation-summary.md)를 참고하세요.

settings는 **별도의 명시적 Linux 전용 작업**입니다. 아래 경로도 가상의 자리표시자입니다.

```sh
node bin/hud statusline settings preview > /absolute/private/statusline-plan.json
node bin/hud statusline settings apply --plan /absolute/private/statusline-plan.json
node bin/hud statusline settings restore --backup /absolute/path/returned-by-apply.json
```

preview를 검토하고 apply가 반환한 backup 경로를 사용하세요. stdout 저장 경로는 backup이 아닙니다. backup을 보관하고 충돌하는 쓰기를 중지한 뒤 작업하세요. 일반 render/build/help는 설치하지 않으며 `--details`도 자동 설치하지 않습니다. macOS/Windows의 settings 설치는 지원하지 않습니다. 비협조적인 writer나 충돌 후 불확실한 결과는 조사해야 하며 맹목적으로 재시도하지 마세요. [안전성과 복구 절차(영어)](./docs/statusline/product-settings.md#optional-installation-workflow)를 참고하세요.

### Pi 관측과 footer

`pi inspect`는 절대 source 또는 정확한 profile 중 하나와 그 안에 포함된 절대 session 파일 하나를 선택합니다. 모델 이름으로 context window를 추정하지 않습니다. 범위가 제한된 header 확인 외에 4 MiB·2,000 records·soft 20 ms 한도를 적용합니다. `partial`과 이어지는 위치를 명시하며 재실행은 새 관측을 시작합니다. 종료 코드 0은 완전한 관측, 6은 불완전한 관측입니다. `pi launch`는 네이티브 설정·자격 증명으로 foreground 실행하며 `--` 뒤의 인수를 그대로 전달하고 상속된 managed claims를 제거합니다. 검증된 binding, MCP 설정, 관리형 위임이 되지는 않습니다.

footer는 문서에 고정된 Pi 1.4.0 API를 대상으로 명시적으로 로드하는 TUI 전용 기능입니다. 모든 버전이나 live-provider 호환성을 뜻하지 않습니다. `/hud-footer off`는 해당 세션에서 네이티브 footer로 복원하며 선택을 저장하지 않습니다. 공유 HUD 정보에는 추가로 명시적 `HUD_HOME`과 `HUD_PI_SOURCE_ROOT`, 일치하는 네이티브 identity/location, 이미 게시된 cache가 필요합니다. footer는 source scan/collector를 시작하지 않습니다. 공유 증거가 없어도 네이티브 정보는 남습니다. [로드 방법(영어)](./docs/cloud/pi-footer.md#try-it-explicitly)을 참고하세요.

### 수동 완료 보고서 digest와 제어 경계

```text
node bin/hud digest plan --run RUN --report REPORT --json
node bin/hud digest run --run RUN --report REPORT --expected-ledger LEDGER_ID --expected-recipient RECIPIENT_ID --json
```

`RUN` / `REPORT` / `LEDGER_ID`는 명시적인 안전한 token(ASCII 영숫자·`_`·`-`, 1–128자)으로 바꿉니다. `RECIPIENT_ID`는 plan과 현재 해석 결과가 가리키는 정확한 소문자 64자리 hex ID이며 추측한 계정 이름이 아닙니다. plan은 메타데이터만 읽고 summary를 보내지 않으며 재사용 가능한 허가증이 아닙니다. run은 현재 선택을 다시 확인하고 두 허가가 모두 있을 때만 인증된 완료 보고서 **한 건의 공개 summary**(최대 32 KiB UTF-8·8,000 Unicode code points)를 전송할 수 있습니다. 완료 보고서나 모델이 작성한 digest는 프로세스 종료 또는 작업의 정확성을 증명하지 않습니다.

private `HUD_HOME/sources/<actual sourceId>/model.json`에서 수동 API digest, 정확한 full-ref의 delegated/result/digest material scope, 유한한 hourly cap을 명시적으로 활성화해야 합니다. 별도의 `outbound.json`이 구체적인 recipient를 허용합니다. 설정이 없거나 잘못되면 거부하며 기존 Codex/native/resultDigest 권한은 이어지지 않습니다. CLI는 이 설정들을 쓰거나 ledger를 생성하지 않고 `reportPath` / transcripts / stdout / parent·task text를 읽지 않으며 프로세스 제어 권한도 주지 않습니다. `language`는 `en` / `zh`만 가능합니다. 이 후보에는 일본어·한국어, CLI/agy backend, `latest`, batch/watch, background/panel 생성, notes save/show, `digest config`, `digest policy`, 자동 scheduler가 없습니다. [명령(영어)](./docs/cloud/f4-digest-cli.md#commands)과 [독립적인 source 설정·허가(영어)](./docs/cloud/f4-digest-cli.md#explicit-private-source-configuration)를 확인하세요.

인증된 parent의 MCP `delegate_close({linkId, expectedRun, request_key, grace?})`는 confirmed/current-owned headless 관계만 독립적인 종료 확인 후 닫을 수 있습니다. 접수 후에도 pending 상태일 수 있습니다. cancel과 close는 별개이며 close는 이력을 삭제하지 않습니다. `hud run close`, 일반 local-manager close, visible-pane close가 아닙니다. visible close, 다시 열기, live send/ask, 일시 중단된 HUD chat UI는 사용할 수 없습니다. [headless 위임 종료 경계(영어)](./packages/hud-mcp/README.md#end-a-headless-delegation)를 참고하세요.

## 설정

### 환경 변수

| 변수 | 기본값 | 설명 |
|------|--------|------|
| `CODEX_HUD_DENSITY` | `balanced` | 상태 표시줄 정보량 (`focus` / `balanced` / `full`) |
| `CODEX_HUD_THEME` | `terminal` | 팔레트 (`terminal` / `mocha` / `latte` / `titanium` / `none`) |
| `CODEX_HUD_GLYPHS` | `both` | 모델 배지 표기 (`glyph` / `text` / `both`) |
| `CODEX_HUD_POSITION` | `bottom` | HUD 패인 위치 (`top` / `bottom`) |
| `CODEX_HUD_HEIGHT` | 1행 | HUD 높이 (행 수) |
| `CODEX_HUD_MOUSE` | `1` | 마우스/트랙패드 스크롤 활성화 |

<details>
<summary>그 밖의 기존 환경 변수</summary>

| 변수 | 기본값 | 설명 |
|------|--------|------|
| `CODEX_HUD_NOTIFY` | `0` | 실패와 에이전트 종료를 tmux로 알림 |
| `CODEX_HUD_NOTIFY_COOLDOWN` | `300` | 같은 종류 알림의 쿨다운 초 |
| `CODEX_HUD_REDUCED_MOTION` | `0` | 통신 마커 애니메이션 중지 |
| `NO_COLOR` | (미설정) | 값이 있으면 `none` 팔레트 강제 |
| `CODEX_HUD_HEIGHT_AUTO` | `0` | 너비에 따라 높이 자동 조정 |
| `CODEX_HUD_HEIGHT_MIN` | `CODEX_HUD_HEIGHT` | 자동 모드 최소 높이 |
| `CODEX_HUD_HEIGHT_MAX` | `12` | 자동 모드 최대 높이 |
| `CODEX_HUD_AUTO_ATTACH` | `0` | 같은 디렉토리의 최신 세션에 자동 연결 |
| `CODEX_HUD_ALTERNATE_SCREEN` | `0` | codex 패인의 tmux alternate-screen |
| `CODEX_HUD_CLEAR_SCROLLBACK` | `0` | 첫 렌더링 시 스크롤백 초기화 |
| `CODEX_HUD_CWD` | (미설정) | 작업 디렉토리 재정의 |
| `CODEX_HOME` | `~/.codex` | Codex 홈 디렉토리 |
| `CODEX_SESSIONS_PATH` | (미설정) | sessions 디렉토리 재정의 |

</details>

### 10개의 표시·설정 별칭

접두사 전체를 바꾸는 규칙이 아니라 다음 10개만 대응합니다.

| 중립 이름 | 기존 이름 |
| --- | --- |
| `HUD_SETTINGS_PATH` | `CODEX_HUD_SETTINGS_PATH` |
| `HUD_THEME` | `CODEX_HUD_THEME` |
| `HUD_DENSITY` | `CODEX_HUD_DENSITY` |
| `HUD_GLYPHS` | `CODEX_HUD_GLYPHS` |
| `HUD_ICONS` | `CODEX_HUD_ICONS` |
| `HUD_LOOK` | `CODEX_HUD_LOOK` |
| `HUD_REDUCED_MOTION` | `CODEX_HUD_REDUCED_MOTION` |
| `HUD_CONTEXT` | `CODEX_HUD_CONTEXT` |
| `HUD_TREE_WIDTH` | `CODEX_HUD_TREE_WIDTH` |
| `HUD_CLEAR_SCROLLBACK` | `CODEX_HUD_CLEAR_SCROLLBACK` |

```sh
HUD_THEME=latte HUD_DENSITY=focus node bin/hud panel
```

중립 이름이 있으면 비어 있거나 잘못된 값이어도 기존 이름보다 우선합니다. 검증 전에 값을 선택하므로 잘못된 중립 값이 기존 값으로 되돌아가지 않습니다. 저장된 표시 설정은 계속 우선하며 비어 있지 않은 `NO_COLOR`가 최종적으로 색상을 끕니다. 선택된 settings override가 비어 있으면 기존 `CODEX_HOME/hud-settings.json` 기본값을 사용하고 가려진 기존 경로로 돌아가지 않습니다.

선택한 기존 settings 파일은 source별 범용 모델 설정이 아니며 이전이나 material/outbound 허가도 하지 않습니다. `HUD_HOME`은 계속 ledger 위치를 지정하고 Codex cache/기본 settings 위치는 바뀌지 않습니다. shell/Windows 실행 제어는 기존 이름을 유지합니다. `HUD_PI_SOURCE_ROOT`는 별도로 정의된 Pi source selector이며 범용 alias 규칙의 근거가 아닙니다. [우선순위(영어)](./docs/cloud/e2-hud-env.md#supported-names-and-precedence)와 [전체 설정 참조(영어)](./docs/reference.md#configuration)를 참고하세요.

### config.toml

HUD는 `CODEX_HOME/config.toml`에서 설정을 읽습니다:

```toml
model = "gpt-5.2-codex"
approval_policy = "on-request"
sandbox_mode = "workspace-write"

[mcp_servers.my-server]
command = ["node", "server.js"]
enabled = true
```

## 지원 시스템

이 표는 기존 Codex 설정의 지원 표를 그대로 보존한 것입니다. 새 CLI, provider, 설치 또는 모든 플랫폼의 검증 완료를 뜻하지 않습니다. 기능별 Linux 전용 등의 제한은 위 설명을 참고하세요.

| 플랫폼 | 상태 |
|--------|------|
| Linux | 지원됨 |
| macOS (Apple Silicon) | 지원됨 |
| macOS (Intel) | 테스트 대기 |
| Windows PowerShell | launcher shell로 지원, native PowerShell HUD는 미지원 |
| Windows cmd | 관리형 `.cmd` shim으로 지원 |
| Windows WSL Ubuntu | Windows 기본 HUD 경로로 지원 |

## 상세 참조(영어)

- [기존 workbench](./README.md#development-workbench)
- [패널](./docs/reference.md#the-panel)
- [키](./docs/reference.md#keys)
- [설정](./docs/reference.md#configuration)
- [기존 상태의 기계 판독 출력](./docs/reference.md#machine-readable-state)
- [명시적 CLI 진입점](./docs/cloud/product-cli.md)
- [네이티브 details 명령](./docs/statusline/native-details.md#commands-and-api)
- [네이티브 정보의 의미](./docs/statusline/native-details.md#admitted-facts-and-absence)
- [부분 위임 summary](./docs/statusline/delegation-summary.md)
- [명시적 statusline 설정](./docs/statusline/product-settings.md#optional-installation-workflow)
- [10개의 중립 별칭](./docs/cloud/e2-hud-env.md#supported-names-and-precedence)
- [Pi footer 명시적 로드](./docs/cloud/pi-footer.md#try-it-explicitly)
- [수동 digest 명령](./docs/cloud/f4-digest-cli.md#commands)
- [독립적인 source 설정·허가](./docs/cloud/f4-digest-cli.md#explicit-private-source-configuration)
- [인증된 parent의 headless close](./packages/hud-mcp/README.md#end-a-headless-delegation)
- [표시 설정 이전](./docs/cloud-development/reversible-migration.md#preview-review-apply-select-restore)
- [현재 클라우드 개발 가이드](./docs/cloud-development/README.md)
- [정확한 미리보기 범위(설치 프로그램이 아님)](./docs/cloud-development/checks-and-preview.md#exact-preview-selection)

## 개발

아래는 사용자가 완전한 소스 체크아웃에서 실행하는 기존 개발 명령입니다. ledger 기능에는 필요에 따라 `npm run build:hud-mcp`도 실행합니다. 빌드 성공만으로 기능 검증이 끝나는 것은 아닙니다. 현재 절차와 증거 범위는 위 클라우드 개발 가이드를 확인하세요.

```bash
npm install && npm run build   # 빌드
npm run dev                    # 감시 모드
node dist/index.js             # HUD 직접 실행
```

## 변경 이력

| 날짜 | 변경 사항 |
|------|-----------|
| 2026-05-22 | Windows current branch의 WSL download/self-check/run 절차와 스크린샷 추가 |
| 2026-04-09 | 빠른 설치/동기화/업그레이드/제거 명령어 추가 |
| 2026-04-09 | HUD 세션을 tmux 패인에 바인딩; reasoning effort 표시 |
| 2026-02-09 | 리사이즈 후 메인 패인 포커스 수정; 마우스 스크롤 기본값 개선 |
| 2026-02-09 | 세션 연결 기본값 및 스크롤백 설정 업데이트 |

문서 변경 이력:

| Date       | Summary of Changes |
|------------|--------------------|
| 2026-05-22 | Windows 사용자를 위한 current branch 다운로드, self-check, WSL 실행 절차와 스크린샷을 추가. |

## 라이선스

MIT

## 크레딧

Jarrod Watts의 [claude-hud](https://github.com/jarrodwatts/claude-hud)에서 영감을 받았습니다. [OpenAI Codex CLI](https://github.com/openai/codex)를 위해 제작되었습니다.
