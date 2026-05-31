# Vent Fan Beat Simulator Vol.2 プロジェクト整理

このドキュメントは、今後の機能追加前に現在の実装内容・機能仕様・GitHub Pages 公開構成を整理するためのものです。アプリ本体の変更は含みません。

## 1. プロジェクト概要

- アプリ名: Vent Fan Beat Simulator Vol.2
- 目的: 壊れかけの換気扇のガタや擦れ具合をパラメータ化して、ランダム気味のビートを楽しむ実験用ツール。
- 体験: 換気扇の羽根、障害物、軸ぶれ、接触強度、音声応答を操作し、機械的な擦れ・衝突からビートを生成する。
- Vol.2 の位置づけ: ルート `index.html` から `./vol2/` へ誘導される現行公開版。`index_v1.html` とルート直下の `main.js` / `style.css` は旧版または比較用のコードとして残っている。
- v2.1 の追加機能: ブラウザ上で鳴っているマスター出力を AudioWorklet 経由でリアルタイム録音し、16-bit PCM WAV としてダウンロードできる。
- v2.2 の追加機能: ユーザーが自分の WAV/MP3 等の音源を画面から追加し、Obstacle のサンプルとして使える。追加音源はサーバーや GitHub にはアップロードされず、同じブラウザ・同じ origin の IndexedDB に保存される。
- v2.3 の UI刷新: ロゴを上部に配置し、黒基調テーマ、カードレイアウト、Core Motion / Rotation Feel / Sound Design / Capture & Storage / User Samples / Obstacle Setup のカテゴリ整理を行った。v2.3.1 では余白を詰め、Obstacle Setup を主要作業エリアとして上部に移動した。v2.3.2 ではロゴの非クロップ表示、主要カラムの左右入れ替え、英語タグライン化を行った。v2.3.3 では desktop の左右カラム幅を半々に近づけ、User Samples 側に少し余裕を持たせた。v2.3.4 では Obstacle 行のはみ出し防止と Preset 行の3領域レイアウトを追加した。
- バージョン運用想定: 今後の軽微な機能追加は基本的に `/vol2/` のまま育て、`PROJECT.md` やアプリ内表記で v2.1, v2.2 のように更新する。旧版を残したいほど大きな仕様変更や別コンセプトの変更のみ、`/vol3/` や別ディレクトリへの分岐を検討する。

## 2. 現在の画面構成

確認元: `vol2/index.html`, `vol2/main.js`, `vol2/style.css`

| UI項目 | 役割 | 初期値 | 最小値/最大値/刻み | 関連する内部変数/関数 | 備考 |
| --- | --- | --- | --- | --- | --- |
| Header / Logo | ブランド表示 | ロゴ画像、`Vol.2 / v2.3.4` | なし | static HTML / CSS | `vol2/assets/vent-fan-beat-logo.jpg` を表示。読み込み失敗時も alt text が残る。ロゴ周りにカード枠は付けず、画像全体が切れない表示を優先する。 |
| Quick Controls | 即時操作エリア | Start、Start Recording、timer、status | なし | `toggleButton`, `recordingButton`, `recordingTime`, `recordingStatus` | 既存IDのボタンを複製せず上部に配置。 |
| Core Motion | 基本動作カテゴリ | なし | なし | なし | Start/Stop は Quick Controls、RPM / Blade Count / Obstacle Count はこのカード内。 |
| Start ボタン | シミュレーションと音声を開始/停止する | `Start` | なし | `toggleButton`, `startSimulation()`, `stopSimulation()`, `ensureAudio()`, `loop()` | 開始後は `Stop` 表記。AudioContext は Start 操作後に初期化・resume される。 |
| Rhythmic Foundation | RPM 系のグループ見出し | なし | なし | なし | UI分類用。 |
| RPM | 回転数。羽根が障害物を通過する速度を決める | `200` | `10`-`2000`, step `1` | `state.rpm`, `stepSimulation()`, `bindSlider()` | 値変更時に `resetCollisionState()`。 |
| Fan Geometry | 羽根・障害物数のグループ見出し | なし | なし | なし | UI分類用。 |
| Blade Count | 羽根枚数 | `3` | `1`-`8`, step `1` | `state.bladeCount`, `resetCollisionState()`, `resetWobblePhases()` | 多いほど接触機会が増える。 |
| Obstacle Count | 障害物数 | `3` | `0`-`8`, step `1` | `state.obstacleCount`, `rebuildObstacles()`, `obstacles` | 0 の場合は障害物編集UIに空状態メッセージを表示。 |
| Rotation Feel | 回転ぶれ系カテゴリ | なし | なし | なし | 旧 Rotation Dynamics をカテゴリ整理。 |
| Axis Jitter | 羽根角度に加える軸ぶれ量 | `0.10` | `0`-`0.4`, step `0.01` | `state.axisJitter`, `stepSimulation()` | 正弦波ぶれとランダムノイズの振幅に使われる。 |
| Timing Jitter (%) | ランダム成分の強さ | `30` | `0`-`100`, step `1` | `state.timingJitter`, `stepSimulation()` | 内部値は `0`-`1`。ランダムノイズ成分に掛かる。 |
| Wobble Freq (Hz) | 軸ぶれの周期 | `3.0` | `0`-`20`, step `0.1` | `state.wobbleFreqHz`, `stepSimulation()` | `sin(wobbleOmega * simTime + phase)` の周波数。 |
| Sound Design | 音声応答系カテゴリ | なし | なし | なし | 旧 Sound & Response をカテゴリ整理。 |
| Hit Threshold | ヒット判定後の発音ゲート | `0.12` | `0.02`-`0.4`, step `0.01` | `state.hitThreshold`, `registerCollision()` | `rawStrength` が閾値未満なら無音。閾値以上は正規化される。 |
| Envelope Tail (ms) | 音量エンベロープの減衰時間 | `250` | `50`-`800`, step `10` | `state.tailMs`, `getTailSeconds()`, `playSampleHit()`, `playNoiseHit()` | 内部では秒に変換し `0.05`-`5` 秒に clamp。 |
| Impact Dynamics (%) | ヒット強度が音量・減衰へ反映される量 | `40` | `0`-`100`, step `1` | `state.impactDynamics`, `getImpactStrength()` | 内部値は `0`-`1`。0 で強度差なし、1 で強度をそのまま反映。 |
| Soft Hit Low-Cut (%) | 弱いヒットほど低域を削る量 | `40` | `0`-`100`, step `1` | `state.softHitLowCut`, `getSoftHitLowCutFactor()` | 内部値は `0`-`1`。弱い音ほど HPF カットオフが上がる。 |
| Voice Mode | 重なった発音の扱い | `Mono (replace)` | `mono` / `poly` | `state.voiceMode`, `setVoiceMode()`, `stopActiveVoice()` | Mono は同一障害物の既存音を短く止める。Poly は重ねる。 |
| Recording | マスター出力のリアルタイムWAV録音 | `Ready`, `00:00.0` | 最大 `120` 秒 | `initRecordingControls()`, `startRecording()`, `stopRecordingAndDownload()`, `encodeWavMono()` | v2.1追加。Start Recording / Stop & Download WAV、録音タイマー、ステータス、`Max 120 sec. WAV only in v2.1.` を表示。 |
| Capture & Storage | 録音詳細とプリセットカテゴリ | なし | なし | `initPresetControls()` など | Recording detail と Presets をまとめる。 |
| User Samples | ブラウザ内だけに保存するユーザー音源管理 | `0 user samples`, `Ready` | 最大5秒、10MB/ファイル、最大20件、概算50MB | `initUserSampleControls()`, `addUserSampleFiles()`, `previewUserSample()`, `deleteUserSample()`, `clearAllUserSamples()` | v2.2追加。Add Audio Files、Preview、Delete、Clear All、Status、ローカル保存注意書きを表示。 |
| Obstacle Setup | 障害物設定カテゴリ | なし | なし | `renderObstacleVolumeControls()`, `renderObstacleAngleControls()` | 頻繁に触る主要作業エリアとして Quick Controls 直下に配置。desktop/mobile とも上位に置く。 |
| Obstacle Volumes | 障害物ごとの音量・On/Off・サンプル選択 | 障害物ごと `100%`, On | 音量 `0`-`150`, step `1` | `renderObstacleVolumeControls()`, `obstacles[].volume`, `obstacles[].sampleIndex`, `obstacles[].enabled` | サンプル選択肢は `samples/manifest.json` とロード済みバッファから生成。 |
| Obstacle Positions (0-360°) | 障害物ごとの角度編集 | 障害物数に応じて等間隔 | 角度は `0`-`360` 相当 | `renderObstacleAngleControls()`, `renderObstacleAngleList()`, `obstacles[].angle` | トラック上のつまみを pointer drag で移動。表示は `#n: xxx.x°`。 |
| Distribute Evenly | 有効な障害物を 0-360° に等間隔配置 | なし | なし | `alignObstaclesToBlades()` | disabled の障害物は配置対象から除外される。関数名は blades だが実装は有効障害物を等分配置。 |
| Presets | プリセット一覧 | 10スロット全て空 | 10スロット | `MAX_PRESETS`, `presets`, `initPresetControls()` | 各スロットに Save / Load / Delete。 |
| Preset 1-10 | 設定の保存先 | `(empty)` | 10 個固定 | `presetSummaryEls`, `savePreset()`, `loadPreset()`, `deletePreset()` | 保存済みは `rpm / blades / obs` の概要表示。 |
| Save | 現在値をプリセットへ保存 | なし | なし | `snapshotCurrentPreset()`, `persistPresets()` | 既存プリセットがある場合は `window.confirm()` で上書き確認。 |
| Load | プリセットをUIと状態へ反映 | なし | なし | `applyPreset()`, `setSliderValue()` | 空プリセットは console warning のみ。 |
| Delete | プリセットを削除 | なし | なし | `deletePreset()`, `persistPresets()` | 空スロットでは何もしない。 |

注記: `impactDynamicsValue` の HTML 初期表示は `100` だが、スライダー初期値は `40` で、`bindSlider()` の初期同期により表示は `40` に更新される。

v2.3.4 のレイアウト:

- desktop: Header / Quick Controls の下に、左カラムへ Core Motion / Rotation Feel / Sound Design を積み、右カラムに Obstacle Setup を配置する。Primary Workbench は完全固定比率ではなく、左 46〜48% / 右 52〜54% 程度のバランスを目安にする。
- secondary tools: User Samples / Capture & Storage は下段に並べる。User Samples はサンプル名やボタン配置の読みやすさを優先し、Capture & Storage より少し広めにしてよい。
- mobile: Header / Quick Controls / Core Motion / Rotation Feel / Sound Design / Obstacle Setup / User Samples / Capture & Storage の1カラム。
- カード高さは無理に揃えず、中身に応じた自然な高さにする。
- Obstacle Setup の volume row は親カードからはみ出さないことを優先し、volume slider は必要以上に横いっぱいに伸ばさない。
- Preset 行は `[name] [summary] [actions]` の3領域を基本とし、actions は右寄せ、summary は必要に応じて ellipsis で省略する。
- Footer description は英語のブランドタグラインとして表示する。

## 3. 音声生成・リズム生成の仕様

### ヒット判定

- `stepSimulation(dt)` が `requestAnimationFrame` の差分時間を受け取り、`SIM_SUBSTEPS = 4` で分割して進める。
- `revPerSec = state.rpm / 60`, `radPerSec = revPerSec * TWO_PI` により回転角速度を求める。
- 各羽根の基本角度は `baseAngle + TWO_PI * bladeIndex / bladeCount`。
- 各羽根には軸ぶれ `wobble` が加算される。
  - deterministic: `axisJitter * sin(wobbleOmega * simTime + phase)`
  - random noise: `axisJitter * 0.15 * timingJitter * (Math.random() * 2 - 1)`
- 障害物角度との差分は `smallestAngleDiff(wobbleAdjustedAngle, obs.angle)`。
- ヒット窓は `hitAngleTol = clamp(deltaTheta * HIT_ANGLE_TOL_MULT, MIN_HIT_ANGLE_TOL, MAX_HIT_ANGLE_TOL)`。
  - `HIT_ANGLE_TOL_MULT = 1.0`
  - `MIN_HIT_ANGLE_TOL = 0.01`
  - `MAX_HIT_ANGLE_TOL = 0.6`
- `diff > 0 && diff <= hitAngleTol` の片側窓に入ったときだけ候補になる。
- `rawStrength = clamp(1 - diff / hitAngleTol, 0, 1)`。
- `wasInHitZone` と `lastHitRev` により、ゾーンへ入った瞬間かつ同一回転内で同じ羽根・障害物ペアが重複発音しないようにしている。
- `obstacle.enabled === false` の場合は `registerCollision()` 内で無音化される。

### ビート密度への影響

- RPM: 回転速度を直接上げるため、単位時間あたりの接触候補が増える。
- Blade Count: 同一回転内の羽根数が増えるため、障害物通過回数が増える。
- Obstacle Count: 障害物数が増えるため、羽根ごとの接触候補が増える。
- 概念上の基本接触密度は `rpm / 60 * bladeCount * enabledObstacleCount` に近い。ただし実装上は片側ヒット窓、閾値、軸ぶれ、disabled 障害物、同一回転重複防止の影響を受ける。

### 揺らぎ

- Axis Jitter は羽根角度へ加算されるぶれの振幅。
- Wobble Freq は deterministic wobble の周波数。
- Timing Jitter は deterministic wobble とは別のランダムノイズ成分の倍率。`0` でも正弦波の軸ぶれは残り、`1` に近いほどランダム成分が強くなる。
- `resetWobblePhases()` は羽根ごとに `TWO_PI * b / bladeCount` の位相を割り当てる。ログ上は locked と記録される。Vol.2 UI には Wobble Mode セレクトは存在しない。

### Hit Threshold

- `registerCollision()` で `rawStrength < hitThreshold` の場合は発音しない。
- 閾値以上のヒットは `strength = (rawStrength - threshold) / (1 - threshold)` で `0`-`1` に正規化される。
- つまり Hit Threshold は発音ゲートであり、通過したヒットの強度レンジも再スケールする。

### Envelope Tail

- `getTailSeconds()` が `tailMs / 1000` を返す。
- サンプル音では `duration = tailSeconds * (0.8 + 0.4 * impact)`。
- ノイズ音では `duration = tailSeconds * (0.6 + 0.3 * impact)`。
- Gain は短い attack 後、指数ランプで `0.0001` へ減衰する。

### Impact Dynamics

- `getImpactStrength(strength)` は `1 - dyn * (1 - strength)` を返す。
- `dyn = 0` では常に `1` で、ヒット強度による音量差が出ない。
- `dyn = 1` では `strength` がそのまま音量・減衰へ反映される。
- サンプル音のゲインは `baseGain 0.3` から `maxGain 1.0` の間で impact により決まる。障害物ごとの volume が掛かり、最大 `1.5` 相当に clamp される。
- ノイズ音のゲインは `min(0.6, 0.12 + impact * 0.6)`。

### Soft Hit Low-Cut

- `getSoftHitLowCutFactor(strength)` は `softHitLowCut * (1 - strength)` を返す。
- 弱いヒットほど factor が大きくなり、highpass filter の cutoff が上がる。
- サンプル音: HPF は `20` Hz から `1400` Hz。
- ノイズ音: HPF は `40` Hz から `1600` Hz。さらに bandpass filter が入る。

### Voice Mode

- Mono: 同じ障害物 index の既存 voice を `stopActiveVoice()` で短く止めてから新しい音を出す。
- Poly: 既存 voice を止めず、新しい音を重ねる。
- active voice は `activeVoices.sample[]` と `activeVoices.noise[]` に分かれて管理される。

### 音声 API とサンプル

- Web Audio API を使用する。
  - `AudioContext` / `webkitAudioContext`
  - `GainNode`
  - `AudioBufferSourceNode`
  - `BiquadFilterNode`
  - `decodeAudioData()`
- `masterGain.gain.value = 0.9`。
- サンプルは `../samples/manifest.json` を fetch し、各 `../samples/*.wav` を decode して使う。
- サンプルがない、または障害物の `sampleIndex` が `-1` / 範囲外の場合はノイズ fallback を使う。
- `createNoiseBuffer()` は 0.3 秒の mono white noise buffer を生成する。

### v2.1 WAV 録音

- マスター出力は AudioWorklet recorder を通る。通常の音声出力は `sample/noise voices -> masterGain -> recorderWorkletNode -> audioContext.destination`。
- AudioWorklet が非対応または初期化失敗した場合は `masterGain -> audioContext.destination` に戻し、録音UIを disabled にする。
- recorder は pass-through node で、録音中だけ入力 PCM を mono mixdown してメインスレッドへ送る。
- 録音中に RPM、Tail、Obstacle Volume、Obstacle Position、Sample、Mono/Poly などを操作した場合、その結果としてリアルタイムに鳴ったマスター出力が WAV に記録される。
- WAV は外部ライブラリなしで `DataView` によりエンコードする。
- WAV 仕様: 16-bit signed integer PCM、mono、sampleRate は `audioContext.sampleRate`、サンプル値は `[-1, 1]` に clamp。
- 録音は固定長ではなく Start Recording / Stop & Download WAV 形式。最大録音時間は `MAX_RECORDING_SECONDS = 120` 秒。
- 録音開始時にシミュレーターが停止中なら自動で Start する。録音停止時は録音だけ止め、シミュレーター再生は継続してよい。
- 録音中にアプリの Stop を押した場合は、先に録音を停止して WAV を生成し、その後シミュレーターを停止する。
- 現行コードでは `Math.random()` はノイズバッファ生成と Timing Jitter のランダム成分に残っている。録音は実際に鳴ったマスター出力を記録するため、ランダム/決定論の違い自体は WAV 保存上の問題にならない。

### v2.2 User Samples

- ユーザー音源は `File.arrayBuffer()` で読み、`audioContext.decodeAudioData()` で `AudioBuffer` 化して、既存サンプル同様に Obstacle 音源として鳴る。
- IndexedDB には `AudioBuffer` ではなく、`id`, `name`, `mimeType`, `size`, `duration`, `createdAt`, `audioData` を保存する。起動後に再度 `decodeAudioData()` して復元する。
- 対応UIは WAV / MP3 recommended。実装上はブラウザが `decodeAudioData()` できる audio file を受け付ける。
- 制限は `MAX_USER_SAMPLE_SECONDS = 5`, `MAX_USER_SAMPLE_BYTES = 10 * 1024 * 1024`, `MAX_USER_SAMPLES = 20`, `APPROX_MAX_USER_SAMPLE_STORAGE_BYTES = 50 * 1024 * 1024`。
- 5秒超過、10MB超過、20件超過、概算50MB超過はファイル単位で拒否し、他の正常ファイルは読み込める。
- 音量正規化、先頭無音トリム、自動クロップは行わない。
- User Sample の Preview も `masterGain` 経由で鳴るため、v2.1 WAV 録音中なら録音に入る。
- User Sample を Obstacle に割り当てた場合も既存 sample/noise voice と同じ音声グラフに流れるため、WAV 録音に自然に含まれる。

## 4. 障害物の仕様

- 内部データ構造は `obstacles` 配列。
- 各障害物は以下を持つ。
  - `angle`: ラジアン角度。表示時は度数へ変換。
  - `sampleIndex`: サンプル選択。`-1` は Noise。
  - `volume`: 音量倍率。UI上は `0`-`150%`。
  - `enabled`: `false` の場合は発音しない。
- `Obstacle Count` 変更時は `rebuildObstacles()` が走る。
  - 既存 index の `angle`, `volume`, `sampleIndex`, `enabled` は可能な限り保持する。
  - 新規障害物は等間隔角度で作られる。
  - sample が利用可能なら `i % availableSamples`、なければ `-1`。
- 障害物ごとの音量設定は `renderObstacleVolumeControls()` が生成する range input で操作する。
- 障害物ごとの角度設定は `renderObstacleAngleControls()` が生成するトラック上の thumb を pointer drag して操作する。
- `Distribute Evenly` は `alignObstaclesToBlades()` を呼び、有効な障害物だけを `0`, `2π/count`, ... に配置する。disabled 障害物の角度は変更しない。
- 障害物が 0 個の場合:
  - Obstacle Volumes: `No obstacles. Increase the obstacle count to edit volumes.`
  - Obstacle Positions: `No obstacles. Increase the obstacle count to place them.`
  - Angle list: `No obstacles.`

## 5. プリセット機能

- プリセットは 10 スロット固定。
- 保存先: `window.localStorage`
- キー名: `ventBeatSimVol2.presets`
- データ形式: 長さ最大 10 の JSON 配列。空スロットは `null`。
- 保存対象:
  - `rpm`
  - `bladeCount`
  - `axisJitter`
  - `hitThreshold`
  - `obstacleCount`
  - `wobbleFreqHz`
  - `tailMs`
  - `timingJitter`
  - `softHitLowCut`
  - `impactDynamics`
  - `obstacleVolumes`
  - `obstacleSampleIndices`
  - `obstacleSampleRefs`
  - `obstacleEnabled`
  - `obstacleAnglesDeg`
- 保存対象外として確認できるもの:
  - `voiceMode` は `snapshotCurrentPreset()` に含まれていないため保存されない。
  - `running` や AudioContext 状態は保存されない。
- 空プリセットの Load は `console.warn()` のみで UI 変更なし。
- 既存プリセットへの Save は `window.confirm()` で上書き確認を行う。
- Delete はスロットを `null` にし localStorage へ再保存する。
- 互換性上の注意:
  - v2.2 では `obstacleSampleRefs` を追加した。形式は `{ type: "noise" }`, `{ type: "builtin", id: "..." }`, `{ type: "user", id: "..." }`。
  - Load 時は `obstacleSampleRefs` があれば優先する。
  - 古いプリセットに `obstacleSampleRefs` がない場合は、既存の `obstacleSampleIndices` を後方互換 fallback として読み続ける。
  - User Sample が削除済み、未復元、見つからない場合は Noise fallback し、console に警告を出す。
  - `applyPreset()` は一部キーがない場合に fallback するが、古いプリセットで存在しない値は現在値が残る場合がある。
  - 障害物配列系は `obstacleCount` を先に反映してから適用される。
  - `voiceMode` を将来プリセット保存対象に追加する場合、既存 localStorage データとの後方互換を考慮する必要がある。

## 6. ファイル構成・主要関数

| ファイル/ディレクトリ | 役割 | 主な関数/コンポーネント | 変更時の注意 |
| --- | --- | --- | --- |
| `index.html` | 公開トップ。`./vol2/` へ meta refresh で誘導 | なし | ここを壊すとトップ URL から Vol.2 に到達できない。 |
| `index_v1.html` | 旧版 UI の HTML | 旧版の各 UI | 現行 Pages の入口ではない。旧版を残す目的なら削除注意。 |
| `main.js` | 旧版またはルート版の JS | Vol.2 に近い関数群 | 現行 `/vol2/` では読み込まれない。コード内に重複宣言なども見えるため、現行仕様の根拠は `vol2/main.js` を優先する。 |
| `style.css` | 旧版またはルート版の CSS | なし | 現行 `/vol2/` では読み込まれない。 |
| `vol2/index.html` | 現行アプリの HTML | Header / Logo、Quick Controls、Core Motion、Rotation Feel、Sound Design、Capture & Storage、User Samples、Obstacle Setup、`<script defer src="main.js">` | ID と `vol2/main.js` のバインドが密結合。相対パスは `style.css` と `main.js`。同じIDの要素を複製しない。 |
| `vol2/main.js` | 現行アプリの状態管理、UIバインド、シミュレーション、音声、プリセット、WAV録音、User Samples | `bindSlider()`, `rebuildObstacles()`, `stepSimulation()`, `registerCollision()`, `playSampleHit()`, `playNoiseHit()`, `ensureAudio()`, `initRecorderWorklet()`, `startRecording()`, `stopRecordingAndDownload()`, `encodeWavMono()`, `initUserSampleControls()`, `addUserSampleFiles()`, `previewUserSample()`, `deleteUserSample()`, `clearAllUserSamples()`, `sampleRefFromSelectValue()`, `snapshotCurrentPreset()`, `applyPreset()` | 主要ロジックが一体化している。変更時は UI ID、state、preset 保存対象、localStorage 互換、sampleRef 互換、IndexedDB fallback、録音中Stop挙動に注意。 |
| `vol2/wav-recorder-worklet.js` | AudioWorklet の pass-through recorder | `WavRecorderProcessor`, `process()` | `masterGain -> recorderNode -> destination` の接続前提。録音中のみ PCM を mono mixdown して送る。 |
| `vol2/style.css` | 黒基調テーマ、カードレイアウト、レスポンシブUI | なし | v2.3で黒基調テーマ、v2.3.1でコンパクトな余白、枠なしブランドヘッダー、カード非ストレッチ方針を追加。v2.3.2でロゴ非クロップ表示と主要カラム左右入れ替え、v2.3.3で desktop カラム幅バランス調整、v2.3.4で Obstacle / Preset 行のはみ出し防止を追加。CSS内に Phase コメントあり。 |
| `vol2/assets/vent-fan-beat-logo.jpg` | UI上部ロゴ画像 | なし | GitHub Pages では `/vol2/assets/vent-fan-beat-logo.jpg` として公開対象。 |
| `samples/` | 公開用 WAV サンプルと manifest | `manifest.json` | `vol2/main.js` から `../samples/manifest.json` として参照される。相対位置変更に注意。 |
| `samples/manifest.json` | サンプル一覧 | `file`, `label` の配列 | 現在 42 エントリ。file 名と実ファイルの一致が必要。 |
| `samples_raw/` | 元 MP3/WAV サンプル | なし | 公開元 root 配下なので Pages 上にも置かれる可能性がある。変換元として使われる。 |
| `tools/prepare_samples.py` | `samples_raw` から `samples` を生成する Python ツール | `detect_leading_silence()`, `process_file()`, `main()` | pydub と ffmpeg が必要。出力 WAV と manifest を更新する。 |
| `docs/changelog.md` | 変更履歴 | なし | v2.2.0 の User Samples、v2.1.0 の WAV 録音、v0.3.0 の Pages/Vol.2 入口変更が記録されている。 |
| `README.md` | 短いプロジェクト名 | なし | 現状は `Vent Fan Beat Sim v2` のみ。 |
| `.gitignore` | ignore 設定 | なし | 現状 `.DS_Store` のみ。`.venv` は ignore されていない。 |
| `.github/workflows/` | GitHub Actions workflow | なし | このリポジトリ内には存在しない。 |
| `.venv/` | Python 仮想環境 | `pyvenv.cfg` など | リポジトリ内に存在するが、用途はコードからは `tools/prepare_samples.py` 用と推測される程度。`.gitignore` 対象ではない。 |
| `pydub-0.25.1-py2.py3-none-any.whl` | pydub wheel | なし | sample preparation 用依存物と思われるが、コードから直接参照はされていない。 |
| `file.txt` | 用途不明 | なし | 内容・用途は今回のコード調査範囲では未確認。 |

### 主要な状態変数

- `state`: UI とシミュレーションの中心状態。`running`, `rpm`, `bladeCount`, `axisJitter`, `timingJitter`, `softHitLowCut`, `hitThreshold`, `obstacleCount`, `wobbleFreqHz`, `tailMs`, `voiceMode`, `impactDynamics`。
- `obstacles`: 障害物配列。
- `wasInHitZone`, `lastHitRev`: 同一ヒットの重複発火を防ぐ状態。
- `wobblePhasePerBlade`: 羽根ごとの軸ぶれ位相。
- `sampleBuffers`, `sampleMetas`: manifest と WAV decode 結果。
- `activeVoices`: Mono mode で既存音を止めるための参照。
- `presets`: localStorage と同期されるプリセット配列。
- `recorderNode`, `recorderReady`, `recorderSupported`, `isRecording`, `recordedChunks`: v2.1 の WAV 録音状態。
- `userSamples`, `userSampleDb`, `userSamplePersistenceAvailable`: v2.2 のブラウザ内ユーザー音源状態。

### 実装上の注意として確認できた点

- `vol2/main.js` には `preloadSampleManifestForUI()` が 2 回定義されている。後の定義が有効になる。現時点では機能変更せず記録のみ。
- 初期化時に `loadSampleBuffers().then(...)` が `AudioContext` 引数なしで呼ばれている。実際の音声用ロードは `ensureAudio()` 内で `loadSampleBuffers(audioContext)` として行われる。機能変更はしていないため、必要なら別途検証対象。
- `APP_VERSION` は `v2.3.4`。画面右下の `appVersion` に `Vent Fan Beat Simulator Vol.2 — v2.3.4` を表示する。

## 7. GitHub Pages 公開構成

ユーザー確認済みの設定:

| 項目 | 内容 |
| --- | --- |
| Repository | `Fukuza440/vent-beat-v2` |
| Visibility | Public |
| GitHub Pages URL | `https://fukuza440.github.io/vent-beat-v2/` |
| 実アプリURL | `https://fukuza440.github.io/vent-beat-v2/vol2/` |
| Source | Deploy from a branch |
| Branch | `main` |
| Folder | `/ (root)` |
| Custom domain | なし |
| Enforce HTTPS | 有効 |

コードから確認できたこと:

- ルート `index.html` は `<meta http-equiv="refresh" content="0; url=./vol2/">` により `./vol2/` へ誘導する。
- ルート `index.html` には fallback link として `./vol2/` へのリンクもある。
- `/vol2/` 配下に実アプリの `index.html`, `main.js`, `style.css` がある。
- `vol2/index.html` は `style.css` と `main.js` を相対パスで読み込む。
- `vol2/main.js` はサンプルを `../samples/manifest.json` と `../samples/<file>` から読み込むため、root 公開前提の配置になっている。
- `vol2/wav-recorder-worklet.js` は `/vol2/` 配下の静的ファイルとして `vol2/main.js` から相対パス `wav-recorder-worklet.js` で読み込まれる。
- ロゴ画像 `vol2/assets/vent-fan-beat-logo.jpg` は `/vol2/assets/vent-fan-beat-logo.jpg` として公開対象になる。
- AudioWorklet は HTTPS の GitHub Pages または localhost での確認を前提とする。非対応環境では録音UIのみ disabled になる。
- User Samples は GitHub Pages や GitHub リポジトリにはアップロードされない。同じブラウザ・同じサイト origin の IndexedDB に保存される。
- `docs/` は存在するが、GitHub Pages の公開元ではない。公開元が root のため、静的ファイルとして URL から到達可能になる可能性はある。
- `.github/workflows/` は存在しないため、このリポジトリのコード上には Pages 用 GitHub Actions workflow は確認できない。
- ユーザー確認済み設定では `gh-pages` ブランチ公開ではなく、`main` ブランチ root の branch 公開方式。
- GitHub Actions による Pages 公開ではない。ただし GitHub 側では Pages の内部デプロイワークフローが動く可能性がある。

公開対象として影響する主なファイル:

- `index.html`
- `vol2/index.html`
- `vol2/main.js`
- `vol2/style.css`
- `samples/manifest.json`
- `samples/*.wav`
- root 配下の静的ファイル全般

## 8. ローカル起動・公開更新の流れ

コードから確認できる範囲では、ビルド不要の静的 HTML/CSS/JS 構成。

- `package.json` は存在しない。
- Vite / webpack などの config は確認できない。
- `vol2/index.html` は classic script を `defer` で読み込む。`type="module"` ではない。

ローカル起動例:

```sh
cd vent-beat-v2
python3 -m http.server 8000
```

確認URL:

- `http://localhost:8000/`
- `http://localhost:8000/vol2/`

注意:

- `vol2/main.js` は `fetch("../samples/manifest.json")` を使うため、`file://` 直開きではなく HTTP server 経由で確認する方が安全。
- `vol2/main.js` 冒頭コメントにも、`file://` と module loading に関する過去の修正メモが残っている。

GitHub Pages への反映は、現状の設定では `main` ブランチ root が公開元なので、基本的には以下の流れ。

```sh
git add .
git commit -m "Update vent beat simulator"
git push origin main
```

ただし、実際のコミットメッセージや対象ファイルは変更内容に合わせる。

## 9. 公開サイト更新時の注意点

- このサイトは GitHub Pages による静的ホスティングである。
- GitHub Pages 単体ではサーバーサイド処理や DB 保存はできない。
- プリセット保存は `localStorage` 依存であり、ブラウザ単位の保存。GitHub や他端末には保存されない。
- `main` ブランチの root が公開対象なので、ルート直下のファイル変更が公開サイトに影響する可能性がある。
- ルート `index.html` の `/vol2/` 誘導を壊すと、トップ URL からアプリに到達できなくなる。
- `/vol2/` 配下の相対パスを壊すと、CSS/JS が読み込めなくなる可能性がある。
- `vol2/main.js` から `../samples/manifest.json` と `../samples/*.wav` を読むため、`samples/` の場所・ファイル名・manifest の整合性が重要。
- GitHub Pages の公開反映には少し時間がかかる場合がある。
- 公開後は `https://fukuza440.github.io/vent-beat-v2/vol2/` で実機確認すること。
- ブラウザの AudioContext 制約により、音声はユーザー操作後に開始する必要がある。現実装では Start ボタン押下後に `ensureAudio()` と `audioContext.resume()` が走る。
- GitHub Pages 上では HTTPS が有効。
- custom domain は現時点では使用していない。

## 10. 今後 Codex が機能追加するときの作業ルール

- 機能追加前に必ず `PROJECT.md` を読むこと。
- 仕様変更・UI追加・保存対象追加を行った場合は `PROJECT.md` も更新すること。
- 現行版は `/vol2/` 配下のアプリであり、軽微な改善は v2.1, v2.2 として `/vol2/` のまま育てること。
- 旧版を残したいほど大きな変更や別コンセプト化を行う場合のみ、`/vol3/` や別ディレクトリ化を検討すること。
- GitHub Pages は `main` ブランチ root 公開なので、root 直下のファイル配置や相対パスを壊さないこと。
- `vol2/main.js` から `../samples/manifest.json` と `../samples/*.wav` を参照しているため、`samples` 配置を変える場合は参照パスも確認すること。
- 録音機能を変更する場合は、音声グラフの `masterGain -> recorderNode -> destination` の接続を壊さないこと。
- 録音中の Stop 挙動、120秒上限、WAV エンコード仕様を壊さないこと。
- sampleRef 互換を壊さないこと。
- 既存プリセットの `obstacleSampleIndices` fallback を壊さないこと。
- IndexedDB 失敗時もアプリ全体が壊れないこと。
- User Samples 削除時の Noise fallback 挙動を壊さないこと。
- UIを追加する場合は Core Motion / Rotation Feel / Sound Design / Capture & Storage / User Samples / Obstacle Setup のカテゴリに沿って配置すること。
- Obstacle Setup は頻繁に触るため下部に追いやらないこと。
- カード高さを無理に揃えないこと。
- ロゴ周りに枠線を付けないこと。
- 余白はコンパクトに保つこと。
- 同じIDの要素を複製しないこと。
- 既存JSバインドを壊さないこと。
- ロゴや黒基調テーマに合う見た目を維持すること。
- プリセット保存対象を追加・変更する場合は、既存 localStorage データとの後方互換を考慮すること。
- 特に `voiceMode` は現状プリセット保存対象外なので、保存対象に追加する場合は既存データの fallback を実装すること。
- 音作り、ランダム感、壊れかけの換気扇っぽさを壊さないこと。
- AudioContext はユーザー操作後に開始する前提を守ること。
- サーバーサイド保存や DB 保存が必要な機能は、GitHub Pages 単体では実現できないため、別途設計判断が必要であること。
- 実装後はローカルと公開URLの両方でスモークテストすること。

## 11. スモークテスト手順

### ローカルスモークテスト

1. `python3 -m http.server 8000` でローカルサーバーを起動する。
2. `http://localhost:8000/vol2/` を開く。
3. 画面が崩れていないことを確認する。
4. ロゴが表示され、黒基調テーマになっていることを確認する。
5. desktop 幅で2カラム + Obstacle下部フル幅、mobile 幅で1カラムになることを確認する。
6. Start を押して音が鳴ることを確認する。
7. Stop を押して停止できることを確認する。
8. RPM を変更してビート間隔が変わることを確認する。
9. Blade Count / Obstacle Count を変更してヒット密度や UI が変わることを確認する。
10. Axis Jitter / Timing Jitter / Wobble Freq を変更して揺らぎが変わることを確認する。
11. Hit Threshold / Envelope Tail / Impact Dynamics / Soft Hit Low-Cut を変更して音の出方が変わることを確認する。
12. Mono / Poly を切り替えて発音挙動が変わることを確認する。
13. 障害物ごとの volume / enabled / sample / angle を操作できることを確認する。
14. Distribute Evenly が動作することを確認する。
15. Preset を Save → Load → Delete できることを確認する。
16. リロード後も保存済みプリセットが残ること、削除済みプリセットが消えることを確認する。
17. Start Recording を押し、停止中だった場合はシミュレーターが自動開始し、Recording timer が進むことを確認する。
18. 録音中に RPM や Tail などを操作し、Stop & Download WAV で WAV がダウンロードされることを確認する。
19. 録音停止後もシミュレーター再生が継続することを確認する。
20. 録音中にアプリの Stop を押した場合、WAV が生成されてからシミュレーターが停止することを確認する。
21. User Samples で複数の WAV/MP3 recommended file を追加できることを確認する。
22. Preview、Delete、Clear All が動作することを確認する。
23. リロード後に IndexedDB から User Samples が復元されることを確認する。
24. User Sample を Obstacle に割り当てて音が鳴ること、WAV 録音にも入ることを確認する。
25. 古い `obstacleSampleIndices` 形式のプリセットが読み込めることを確認する。
26. User Sample 削除後、それを参照する Obstacle / Preset が Noise fallback することを確認する。
27. DevTools Console に JavaScript エラーが出ていないことを確認する。
28. Network タブで `style.css`, `main.js`, `wav-recorder-worklet.js`, `assets/vent-fan-beat-logo.jpg`, `samples/manifest.json`, `samples/*.wav` が 404 になっていないことを確認する。

### 公開サイトスモークテスト

1. `https://fukuza440.github.io/vent-beat-v2/` を開く。
2. `/vol2/` に誘導されることを確認する。
3. `https://fukuza440.github.io/vent-beat-v2/vol2/` に直接アクセスできることを確認する。
4. ローカルスモークテストと同じ主要操作を公開サイトでも確認する。
5. Start Recording / Stop & Download WAV で WAV がダウンロードされ、再生できることを確認する。
6. User Samples が IndexedDB に保存され、GitHub へアップロードされないことを確認する。
7. DevTools Console に JavaScript エラーがないことを確認する。
8. Network タブで CSS / JS / worklet / samples の読み込みが 404 になっていないことを確認する。

## 12. 現在の制約・注意点

- ブラウザのオーディオ再生制約:
  - `AudioContext` は Start ボタン押下後の `startSimulation()` から `ensureAudio()` で作成される。
  - `audioContext.resume()` も Start 処理内で呼ばれる。
  - Stop 時は `audioContext.suspend()`。
- スマホ/PC対応:
  - CSS は `width: min(640px, 95vw)`, flex, wrap を使っている。
  - angle thumb は pointer events と `touch-action: none` を使うためタッチ操作を想定している。
  - ただし個別の viewport テスト結果はコードからは確認できない。
- パラメータ変更中の音声挙動:
  - 多くの slider は `input` イベントで即時 `state` に反映される。
  - RPM / Blade Count / Obstacle Count / angle drag 完了 / Distribute Evenly などは衝突状態を reset する。
  - Axis Jitter, Timing Jitter, Wobble Freq, Threshold, Tail, Dynamics, Low-Cut は再生中でも次以降の計算・発音に反映される。
- localStorage:
  - プリセットはブラウザごとの localStorage に保存される。
  - private browsing や storage 制限環境では保存に失敗する可能性があり、実装は `console.warn()` で記録する。
- GitHub Pages:
  - 静的サイトであり、ビルド処理は確認できない。
  - root 公開なので `docs/`, `samples_raw/`, `tools/` も静的ファイルとして含まれる可能性がある。
- `.venv`:
  - リポジトリ内に `.venv/` が存在する。
  - コード上は `.venv` を直接参照していない。
  - `tools/prepare_samples.py` が Python + pydub を使うため、そのための環境と推測できるが断定はできない。
- Python ツール:
  - `tools/prepare_samples.py` は `samples_raw/` 内の `.mp3` / `.wav` を mono 44100Hz WAV に変換し、先頭無音をトリムし、`samples/manifest.json` を生成する。
  - 依存: pydub。mp3 読み込みには ffmpeg が必要。

## 13. 既知の改善候補

以下はコード調査から見えた候補であり、このドキュメント作成では実装しない。

- プリセット名の編集。
- プリセットに `voiceMode` を含める。
- ランダム生成ボタン。
- 障害物角度やヒットタイミングのパターン可視化。
- 現在のヒット密度や BPM 相当の表示。
- サンプルカテゴリ別フィルタ。
- サンプルロード状態の UI 表示。
- MP3書き出し。
- MIDI書き出し。
- Project JSON / automation log 書き出し。
- Project Pack Export。
- ユーザー音源込みの共有/エクスポート。
- Stems書き出し。
- 録音時間上限の UI 設定化。
- stereo WAV 対応。
- 音源名編集。
- 波形プレビュー。
- 音量正規化。
- 先頭無音トリム。
- storage usage 表示の改善。
- 透過PNG/SVGロゴ対応。
- favicon追加。
- キーボードアサイン機能。
- ヒットメーター/ライブ可視化。
- 折りたたみセクション。
- UIテーマ切替。
- `preloadSampleManifestForUI()` の重複定義整理。
- 初期化時の `loadSampleBuffers()` 呼び出しと AudioContext 依存の整理。
- `.venv` や生成物の git 管理方針整理。
- `README.md` の起動方法・公開URL・Vol.2 説明の拡充。
- GitHub Pages が root 公開であるため、`samples_raw/`, `tools/`, `docs/`, その他 root 配下のファイルが公開対象になり得る。公開不要ファイルを整理するか、将来的に公開用ディレクトリ構成を検討する。
- `.venv/` がリポジトリ内に存在し、`.gitignore` 対象ではないため、今後 git 管理方針を整理する。
- `README.md` にローカル起動方法、公開URL、Vol.2 の位置づけ、GitHub Pages 運用を追記する。
- mobile viewport での実機確認と必要に応じた UI 微調整。

## 確認済み事項と未確認事項

確認済み:

- 現行入口は root `index.html` から `./vol2/`。
- Vol.2 アプリは `vol2/index.html`, `vol2/main.js`, `vol2/style.css`。
- サンプルは `samples/manifest.json` と `samples/*.wav`。
- プリセットは localStorage の `ventBeatSimVol2.presets`。
- `.github/workflows/` と `package.json` は存在しない。
- `.venv/` は存在する。

未確認・推測:

- GitHub の実際の Pages 設定はユーザー確認済み情報として記載した。ローカルコードだけでは GitHub 管理画面の現在値までは検証できない。
- `.venv` の用途は `tools/prepare_samples.py` 用と推測されるが、コードから直接は確認できない。
- `file.txt` の用途は未確認。
- スマホ/PC の見た目は CSS から対応意図を確認したのみで、実機・スクリーンショット検証はしていない。
