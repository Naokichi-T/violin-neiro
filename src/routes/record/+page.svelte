<script>
  // ===== 録音して聴き返すページ =====
  // 弾いた音を録音しながら音程も測り、止めたら「一番近い音からのずれ」のグラフを出す。
  // 再生すると、グラフの上を縦線が動く。グラフを押すと、その場所から再生する。

  import { onMount } from "svelte";

  // 調の一覧と、調に関する関数
  import { KEYS, getKey, getKeyMenuLabel, getScaleNames } from "#lib/key.js";

  // マイクのオン・オフと、録音に使う音の流れ
  import { startMicrophone, stopMicrophone, createRecordingStream } from "#lib/microphone.js";

  // 録音
  import { startRecorder, stopRecorder, cancelRecorder } from "#lib/recorder.js";

  // 一番近い音を探す関数と、グラフの計算
  import { findNearestNoteInKey } from "#lib/nearestNote.js";
  import { analyzeSamples, makeNoteLabels, GAP_SECONDS } from "#lib/recordGraph.js";

  // 音のデータを「ラ4」のような文字にする関数
  import { noteToText } from "#lib/score.js";

  // 画面が暗くならないようにする関数
  import { keepScreenOn, allowScreenOff } from "#lib/wakeLock.js";

  // 設定（音律・調）の保存と読み込み
  import { RECORD_TEMPERAMENTS, DEFAULT_RECORD_SETTINGS, loadRecordSettings, saveRecordSettings } from "#lib/recordSettings.js";

  // ===== 設定値 =====

  // 録音できる長さの上限（秒）。弾き始めてから5分
  const MAX_SECONDS = 300;

  // 弾き始めの何秒前からをグラフと再生の始まりにするか（出だしが切れないように）
  const LEAD_SECONDS = 0.3;

  // これ以内のずれなら「合っている」とみなす（うすい緑の帯）幅（セント）
  const OK_CENTS = 5;

  // グラフの縦の目盛りの上限・下限（セント）。はみ出したら端に貼り付ける
  const GRAPH_CENTS = 50;

  // グラフの横の、1秒あたりの幅（px）
  const PX_PER_SECOND = 60;

  // グラフの高さと、線を描く範囲（SVG の座標）
  const GRAPH_HEIGHT = 200;
  const PLOT_TOP = 28;
  const PLOT_BOTTOM = 184;

  // 縦の目盛りの数字を出す、左の欄の幅（px）
  const AXIS_WIDTH = 40;

  // グラフの右端の余白（px）。最後の音名の札がはみ出さないように
  const GRAPH_RIGHT_PADDING = 40;

  // ===== 画面の状態 =====

  // 選んでいる音律の id（'pythagorean' か 'just'）
  let temperamentId = $state(DEFAULT_RECORD_SETTINGS.temperamentId);

  // 選んでいる調の id
  let keyId = $state(DEFAULT_RECORD_SETTINGS.keyId);

  // 保存しておいた設定を読み込み終わったかどうか（最初の値で保存を上書きしないため）
  let loaded = $state(false);

  // 今の段階
  //   'idle'      ：まだ録音していない
  //   'waiting'   ：「録音」を押して、弾き始めるのを待っている（裏ではもう録音している）
  //   'recording' ：弾き始めたあと（録音と計測をしている）
  //   'stopping'  ：止めて、録音のデータができるのを待っている
  //   'done'      ：録音が終わって、グラフと再生のボタンを出している
  let status = $state("idle");

  // 弾き始めてからの秒数（録音中に表示する）
  let elapsed = $state(0);

  // 今聞こえている音の周波数（聞こえていないときは null）
  let currentFrequency = $state(null);

  // 録音した音の、グラフの左端からの時刻と周波数（止めたあとに入れる）
  // 数が多い（5分で約18000個）ので、中身を細かく見張らない $state.raw にする
  let samples = $state.raw([]);

  // グラフの長さ（秒）
  let duration = $state(0);

  // 録音した音のデータの URL と、ダウンロードするときのファイル名
  let audioUrl = $state("");
  let fileName = $state("");

  // 再生しているかどうか
  let playing = $state(false);

  // 再生している位置（グラフの左端からの秒）
  let playbackTime = $state(0);

  // マイクが使えなかったときなどのメッセージ
  let errorMessage = $state("");

  // グラフを入れている横スクロールの枠と、その幅（px）
  let scroller = $state(null);
  let scrollerWidth = $state(0);

  // ===== 画面に出さない値 =====

  // 録音が本当に始まった時刻（秒）。まだ始まっていないときは null
  let recordStartTime = null;

  // 弾き始めた時刻（秒）。まだ弾いていないときは null
  let soundStartTime = null;

  // 録音中に測った音（時刻は、ページを開いてからの秒）
  let rawSamples = [];

  // 録音のファイルの中で、グラフの左端が何秒のところか（再生の位置を合わせるのに使う）
  let audioOffset = 0;

  // 再生に使う audio の部品
  let audio = null;

  // 再生中に縦線を動かす処理の予約番号
  let playbackFrameId = null;

  // ===== 計算する値 =====

  // 選んでいる調のデータと、その音階
  const key = $derived(getKey(keyId));
  const scaleNames = $derived(getScaleNames(key));

  // 録音中・待っている間かどうか
  const running = $derived(status === "waiting" || status === "recording");

  // 今聞こえている音に一番近い音と、そこからのずれ（録音中に表示する）
  const currentNearest = $derived(currentFrequency !== null ? findNearestNoteInKey(currentFrequency, key, temperamentId) : null);
  const currentCents = $derived(currentNearest !== null ? 1200 * Math.log2(currentFrequency / currentNearest.frequency) : null);

  // グラフに描く点（一番近い音からのずれ）。音律や調を変えると、計算し直される
  const points = $derived(analyzeSamples(samples, key, temperamentId));

  // 音名の札
  const labels = $derived(makeNoteLabels(points));

  // グラフの線
  const graphPath = $derived(makeGraphPath(points));

  // グラフの横幅（px）：録音の長さぶん。短いときは枠の幅いっぱいにする
  const graphWidth = $derived(Math.max(scrollerWidth, Math.ceil(duration * PX_PER_SECOND) + GRAPH_RIGHT_PADDING));

  // 横の目盛り（秒）の一覧。長い録音でも混みすぎないように、5秒ごとに数字を出す
  const ticks = $derived.by(() => {
    const list = [];
    for (let t = 0; t <= duration; t += 5) {
      list.push(t);
    }
    return list;
  });

  // ===== 起動と後片付け =====

  onMount(() => {
    // 保存しておいた設定を読み込んで、画面に反映する
    const saved = loadRecordSettings();
    temperamentId = saved.temperamentId;
    keyId = saved.keyId;
    loaded = true;

    // ページを離れるときは、録音・マイク・再生を全部止めて片付ける
    return () => {
      cancelRecorder();
      stopMicrophone();
      allowScreenOff();
      releaseAudio();
    };
  });

  // 設定が変わったら、ブラウザに保存する
  $effect(() => {
    // 中で使う値を先に読んで、どれが変わってもこの処理が呼ばれるようにする
    const settings = { temperamentId, keyId };
    if (loaded) {
      saveRecordSettings(settings);
    }
  });

  // ===== グラフの計算 =====

  /**
   * 秒を、グラフの横の位置（SVG の x 座標）に直す関数
   * @param {number} time - グラフの左端からの秒
   * @returns {number} x 座標
   */
  function timeToX(time) {
    return time * PX_PER_SECOND;
  }

  /**
   * ずれ（セント）を、グラフの縦の位置（SVG の y 座標）に直す関数
   * 上がプラス（高い）、下がマイナス（低い）。はみ出す値は上下の端に貼り付ける。
   * @param {number} cents - ずれ（セント）
   * @returns {number} y 座標
   */
  function centsToY(cents) {
    const clamped = Math.min(Math.max(cents, -GRAPH_CENTS), GRAPH_CENTS);
    const middle = (PLOT_TOP + PLOT_BOTTOM) / 2;
    return middle - (clamped / GRAPH_CENTS) * ((PLOT_BOTTOM - PLOT_TOP) / 2);
  }

  /**
   * グラフの点から、線（SVG の path）を作る関数
   * 音が途切れたところと、別の音に変わったところでは、線をいったん切る。
   * @param {{time: number, cents: number, name: string}[]} list - グラフの点
   * @returns {string} path の d 属性の文字（点がないときは空文字）
   */
  function makeGraphPath(list) {
    let path = "";
    let previous = null;

    for (const point of list) {
      const x = timeToX(point.time).toFixed(1);
      const y = centsToY(point.cents).toFixed(1);

      // 最初の点・時間があいたとき・別の音に変わったときは「ここから描き始める」（M）
      // それ以外は「前の点から線を引く」（L）
      const startNew = previous === null || point.time - previous.time > GAP_SECONDS || point.name !== previous.name;
      path += (startNew ? "M" : "L") + x + "," + y + " ";
      previous = point;
    }

    return path;
  }

  // ===== 録音の処理 =====

  /**
   * 「録音」を押したときの関数
   * 前の録音を捨てて、マイクと録音を始め、弾き始めるのを待つ。
   */
  async function start() {
    // 前の録音と結果を捨てる
    releaseAudio();
    errorMessage = "";
    samples = [];
    duration = 0;
    elapsed = 0;
    currentFrequency = null;
    rawSamples = [];
    recordStartTime = null;
    soundStartTime = null;

    status = "waiting";

    try {
      // マイクをオンにする（音程を測る）
      await startMicrophone(handlePitch);

      // 待っている間に止められていたら、ここで終わる
      if (status !== "waiting") {
        return;
      }

      // マイクの音（iPad・iPhone では30倍にしたもの）を録音に渡して、録音を始める
      const stream = createRecordingStream();
      if (stream === null) {
        throw new Error("マイクの音を取り出せませんでした。");
      }
      startRecorder(stream, (time) => {
        recordStartTime = time;
      });

      // 録音している間は、画面が暗くならないようにする
      keepScreenOn();
    } catch (error) {
      // マイクの使用を断られた・録音できないブラウザなど
      cancelRecorder();
      stopMicrophone();
      status = "idle";
      errorMessage = error instanceof Error ? error.message : "録音を始められませんでした。";
    }
  }

  /**
   * マイクで音程を調べるたびに呼ばれる関数（1秒に約60回）
   * 弾き始めるのを待つ → 測った音をためる → 5分になったら止める、を進める。
   * @param {number|null} frequency - 周波数（音が小さい・はっきりしないときは null）
   * @param {number} now - 今の時刻（秒）
   */
  function handlePitch(frequency, now) {
    // ----- 弾き始めるのを待っているとき -----
    if (status === "waiting") {
      // 録音がまだ始まっていない・音が出ていないときは、待ち続ける
      if (recordStartTime === null || frequency === null) {
        return;
      }
      // 弾き始めたので、ここからを録音として扱う
      status = "recording";
      soundStartTime = now;
    }

    if (status !== "recording") {
      return;
    }

    // 弾き始めてからの秒数
    elapsed = now - soundStartTime;
    currentFrequency = frequency;

    // 音が聞こえたときだけ、ためておく
    if (frequency !== null) {
      rawSamples.push({ time: now, frequency });
    }

    // 5分になったら、止める
    if (elapsed >= MAX_SECONDS) {
      finish();
    }
  }

  /**
   * 録音を止める関数（「止める」を押したとき・5分になったとき）
   * 録音のデータを受け取り、グラフを作る。
   */
  async function finish() {
    // 弾き始める前に止めたときは、録音を捨てて最初の状態に戻る
    if (status === "waiting") {
      cancelRecorder();
      stopMicrophone();
      allowScreenOff();
      status = "idle";
      return;
    }
    if (status !== "recording") {
      return;
    }

    status = "stopping";
    const stopTime = performance.now() / 1000;
    currentFrequency = null;

    // 先に録音を止めて（最後のかけらまで受け取る）、そのあとマイクを切る
    const recorded = await stopRecorder();
    stopMicrophone();
    allowScreenOff();

    if (recorded === null) {
      status = "idle";
      errorMessage = "録音のデータを受け取れませんでした。";
      return;
    }

    // グラフの左端：弾き始めの少し前（ただし、録音が始まる前にはしない）
    const graphStart = Math.max(recordStartTime, soundStartTime - LEAD_SECONDS);
    audioOffset = graphStart - recordStartTime;
    duration = stopTime - graphStart;

    // 測った音の時刻を、グラフの左端からの秒に直す
    samples = rawSamples.map((sample) => ({
      time: sample.time - graphStart,
      frequency: sample.frequency,
    }));
    rawSamples = [];

    // 再生とダウンロードの準備
    audioUrl = URL.createObjectURL(recorded.blob);
    fileName = makeFileName(new Date(), recorded.extension);
    prepareAudio();
    playbackTime = 0;

    status = "done";
  }

  /**
   * 「録音」「止める」ボタンを押したときの関数
   */
  function handleToggle() {
    if (running) {
      finish();
    } else {
      start();
    }
  }

  // ===== 再生の処理 =====

  /**
   * 再生に使う audio の部品を用意する関数
   */
  function prepareAudio() {
    audio = new Audio(audioUrl);
    audio.preload = "auto";

    // .webm の録音は、長さ（duration）が「分からない」になっていて、途中から再生できないことがある。
    // いったん最後まで飛ばすと長さが分かるので、そのあと頭に戻す（よく知られた直し方）
    audio.addEventListener("loadedmetadata", () => {
      if (audio && audio.duration === Infinity) {
        const fixDuration = () => {
          if (audio) {
            audio.removeEventListener("timeupdate", fixDuration);
            audio.currentTime = audioOffset;
          }
        };
        audio.addEventListener("timeupdate", fixDuration);
        audio.currentTime = 1e101;
      }
    });

    // 最後まで再生したら、止まった状態にする
    audio.addEventListener("ended", () => {
      playing = false;
      stopPlaybackLoop();
    });
  }

  /**
   * 再生をやめて、audio の部品と録音のデータの URL を片付ける関数
   */
  function releaseAudio() {
    stopPlaybackLoop();
    if (audio !== null) {
      audio.pause();
      audio = null;
    }
    if (audioUrl) {
      URL.revokeObjectURL(audioUrl);
      audioUrl = "";
    }
    playing = false;
  }

  /**
   * 「再生」「一時停止」ボタンを押したときの関数
   */
  function togglePlayback() {
    if (audio === null) {
      return;
    }

    if (playing) {
      audio.pause();
      playing = false;
      stopPlaybackLoop();
    } else {
      // 最後まで再生し終わっていたら、頭から
      if (playbackTime >= duration - 0.05) {
        playbackTime = 0;
      }
      playFrom(playbackTime);
    }
  }

  /**
   * グラフの指定した位置から再生する関数
   * @param {number} time - グラフの左端からの秒
   */
  function playFrom(time) {
    if (audio === null) {
      return;
    }
    playbackTime = Math.min(Math.max(time, 0), duration);
    audio.currentTime = audioOffset + playbackTime;
    audio.play();
    playing = true;
    startPlaybackLoop();
  }

  /**
   * 再生中に、縦線の位置を音に合わせて動かし続ける処理を始める関数
   */
  function startPlaybackLoop() {
    stopPlaybackLoop();
    const loop = () => {
      if (audio === null || !playing) {
        return;
      }
      playbackTime = Math.max(audio.currentTime - audioOffset, 0);
      followCursor();
      playbackFrameId = requestAnimationFrame(loop);
    };
    loop();
  }

  /**
   * 縦線を動かす処理を止める関数
   */
  function stopPlaybackLoop() {
    if (playbackFrameId !== null) {
      cancelAnimationFrame(playbackFrameId);
      playbackFrameId = null;
    }
  }

  /**
   * 縦線が枠の外に出そうになったら、グラフを横にスクロールして追いかける関数
   * 縦線が枠の右から2割のところまで来たら、縦線が左から3割の位置に来るようにずらす。
   */
  function followCursor() {
    if (scroller === null) {
      return;
    }
    const x = timeToX(playbackTime);
    const left = scroller.scrollLeft;
    const width = scroller.clientWidth;
    if (x < left || x > left + width * 0.8) {
      scroller.scrollLeft = Math.max(x - width * 0.3, 0);
    }
  }

  /**
   * グラフを押したときの関数：押した場所から再生する
   * @param {MouseEvent} event - 押したときの情報
   */
  function handleGraphClick(event) {
    // 押した場所が、グラフの左端から何 px か
    const rect = /** @type {SVGElement} */ (event.currentTarget).getBoundingClientRect();
    const x = event.clientX - rect.left;
    playFrom(x / PX_PER_SECOND);
  }

  // ===== 表示用の関数 =====

  /**
   * 秒を「分:秒」の文字にする関数
   * @param {number} seconds - 秒
   * @returns {string} 例：'1:05'
   */
  function formatTime(seconds) {
    const total = Math.floor(seconds);
    const minutes = Math.floor(total / 60);
    const rest = total % 60;
    return minutes + ":" + String(rest).padStart(2, "0");
  }

  /**
   * ずれ（セント）を、符号付きの文字にする関数
   * @param {number} cents - ずれ（セント）
   * @returns {string} 例：'+3'、'−5'、'±0'
   */
  function formatCents(cents) {
    const rounded = Math.round(cents);
    if (rounded > 0) {
      return "+" + rounded;
    } else if (rounded < 0) {
      return "−" + Math.abs(rounded);
    } else {
      return "±0";
    }
  }

  /**
   * ずれ（セント）に合わせた色の名前を返す関数（合っている＝緑、高い＝赤、低い＝青）
   * @param {number|null} cents - ずれ（セント）
   * @returns {string} CSS のクラス名
   */
  function centsClass(cents) {
    if (cents === null) {
      return "none";
    } else if (Math.abs(cents) <= OK_CENTS) {
      return "ok";
    } else if (cents > 0) {
      return "high";
    } else {
      return "low";
    }
  }

  /**
   * ダウンロードするときのファイル名を作る関数
   * @param {Date} date - 録音した日時
   * @param {string} extension - 拡張子（'m4a' や 'webm'）
   * @returns {string} 例：'violin-neiro-20261026-0915.m4a'
   */
  function makeFileName(date, extension) {
    const pad = (/** @type {number} */ n) => String(n).padStart(2, "0");
    const day = date.getFullYear() + pad(date.getMonth() + 1) + pad(date.getDate());
    const time = pad(date.getHours()) + pad(date.getMinutes());
    return "violin-neiro-" + day + "-" + time + "." + extension;
  }
</script>

<svelte:head>
  <title>録音して聴き返す｜バイオリン音色練習</title>
  <meta name="description" content="バイオリンの演奏を録音して聴き返し、音程のずれをグラフで振り返る練習ページ" />
</svelte:head>

<!-- ===== ホームへ戻るリンクと見出し ===== -->
<a class="back" href="/">← ホーム</a>
<h1 class="title">録音して聴き返す</h1>
<p class="lead">「録音」を押してから弾き始めると、音が出たところから録音します。止めると音程のグラフが出ます。</p>

<!-- ===== 音律を選ぶ ===== -->
<section class="row">
  <span class="label">音律</span>
  <div class="toggle-group" role="group" aria-label="音律">
    {#each RECORD_TEMPERAMENTS as temperament (temperament.id)}
      <button type="button" class="toggle" aria-pressed={temperamentId === temperament.id} onclick={() => (temperamentId = temperament.id)}>
        {temperament.name}
      </button>
    {/each}
  </div>
</section>

<!-- ===== 調を選ぶ ===== -->
<!-- ピタゴラス音律でも、シ♭とラ♯のように呼び方で高さが変わるので、どちらの音律でも調を選ぶ -->
<section class="row">
  <label class="label" for="key-select">調</label>
  <div class="field">
    <select id="key-select" class="select" bind:value={keyId}>
      {#each KEYS as k (k.id)}
        <option value={k.id}>{getKeyMenuLabel(k)}</option>
      {/each}
    </select>
    <p class="scale">{scaleNames.join(" ")}</p>
  </div>
</section>

<!-- ===== 今の様子 ===== -->
<div class="now">
  {#if status === "idle"}
    <p class="now-message">「● 録音」を押してから弾き始めてください</p>
  {:else if status === "waiting"}
    <p class="now-message">音を出すと録音が始まります</p>
  {:else if status === "recording"}
    <div class="now-row">
      <span class="now-time"><span class="rec-dot">●</span> {formatTime(elapsed)} / 5:00</span>
      <span class="now-note">
        {currentNearest ? noteToText(currentNearest.note) : ""}
        <span class="now-cents {centsClass(currentCents)}">
          {currentCents !== null ? formatCents(currentCents) : "−−"}
        </span>
      </span>
    </div>
  {:else if status === "stopping"}
    <p class="now-message">録音をまとめています…</p>
  {:else}
    <p class="now-message">録音 {formatTime(duration)}（グラフを押すと、そこから再生します）</p>
  {/if}
</div>

<!-- ===== グラフと再生（録音が終わったら出す） ===== -->
{#if status === "done"}
  <div class="graph-area">
    <!-- 縦の目盛りの数字（横にスクロールしても動かない） -->
    <svg class="axis" width={AXIS_WIDTH} height={GRAPH_HEIGHT} aria-hidden="true">
      {#each [50, 25, 0, -25, -50] as value (value)}
        <text class="graph-label" x={AXIS_WIDTH - 6} y={centsToY(value) + 4} text-anchor="end">
          {value > 0 ? "+" + value : value === 0 ? "0" : "−" + Math.abs(value)}
        </text>
      {/each}
    </svg>

    <!-- グラフ本体（長い録音は横にスクロールする） -->
    <div class="scroller" bind:this={scroller} bind:clientWidth={scrollerWidth}>
      <!-- グラフを押すとその場所から再生する。キーボードでは「再生」ボタンで操作できるので、グラフ自体はクリックだけにする -->
      <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
      <svg class="graph" width={graphWidth} height={GRAPH_HEIGHT} role="img" aria-label="時間ごとの、一番近い音からの音程のずれのグラフ" onclick={handleGraphClick}>
        <!-- 「合っている」範囲（±5セント）を、うすい緑で塗る -->
        <rect class="graph-ok" x="0" y={centsToY(OK_CENTS)} width={graphWidth} height={centsToY(-OK_CENTS) - centsToY(OK_CENTS)} />

        <!-- 横の線（+50・+25・0・−25・−50） -->
        {#each [50, 25, 0, -25, -50] as value (value)}
          <line class={value === 0 ? "graph-zero" : "graph-grid"} x1="0" x2={graphWidth} y1={centsToY(value)} y2={centsToY(value)} />
        {/each}

        <!-- 5秒ごとの時刻の数字 -->
        {#each ticks as t (t)}
          <text class="graph-label" x={timeToX(t) + 2} y={GRAPH_HEIGHT - 2}>{formatTime(t)}</text>
        {/each}

        <!-- 音名の札と、音の切れ目の点線 -->
        {#each labels as label, index (index)}
          <line class="graph-divider" x1={timeToX(label.start)} x2={timeToX(label.start)} y1={PLOT_TOP - 4} y2={PLOT_BOTTOM} />
          <text class="note-label" x={timeToX(label.start) + 3} y={PLOT_TOP - 10}>{label.name}</text>
        {/each}

        <!-- 音程の線 -->
        <path class="graph-line" d={graphPath} />

        <!-- 再生している位置の縦線 -->
        <line class="graph-cursor" x1={timeToX(playbackTime)} x2={timeToX(playbackTime)} y1={PLOT_TOP - 20} y2={PLOT_BOTTOM} />
      </svg>
    </div>
  </div>

  <!-- 再生とダウンロード -->
  <div class="playback">
    <button type="button" class="sub-button" onclick={togglePlayback}>
      {playing ? "❚❚ 一時停止" : "▶ 再生"}
    </button>
    <a class="sub-button" href={audioUrl} download={fileName}>ダウンロード</a>
  </div>
{/if}

<!-- マイクが使えなかったときなどのメッセージ -->
{#if errorMessage}
  <p class="error">{errorMessage}</p>
{/if}

<!-- ===== 録音・止めるボタン ===== -->
<button type="button" class="play" class:running disabled={status === "stopping"} onclick={handleToggle}>
  {running ? "■ 止める" : status === "done" ? "● もう一度録音" : "● 録音"}
</button>

<style>
  /* ----- ホームへ戻るリンク ----- */
  .back {
    display: inline-block;
    margin-bottom: 8px;
    color: var(--accent);
    text-decoration: none;
    font-size: 0.95rem;
  }

  /* ----- 見出しと説明 ----- */
  .title {
    margin: 0;
    font-size: 1.5rem;
  }

  .lead {
    margin: 4px 0 20px;
    color: var(--text-sub);
    font-size: 0.9rem;
  }

  /* ----- 1行の設定（左に名前、右に選ぶ部分） ----- */
  .row {
    display: flex;
    align-items: flex-start;
    gap: 12px;
    margin-bottom: 16px;
  }

  .label {
    flex: 0 0 3em;
    padding-top: 8px;
    font-size: 0.95rem;
    color: var(--text-sub);
  }

  .field {
    flex: 1;
    min-width: 0;
  }

  /* ----- 2つから選ぶボタン ----- */
  .toggle-group {
    flex: 1;
    display: flex;
    gap: 8px;
  }

  .toggle {
    flex: 1;
    padding: 8px 4px;
    font-size: 0.95rem;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--card-bg);
    color: var(--text);
    cursor: pointer;
  }

  .toggle[aria-pressed="true"] {
    background: var(--accent);
    border-color: var(--accent);
    color: #ffffff;
    font-weight: bold;
  }

  /* ----- 調のメニュー ----- */
  .select {
    width: 100%;
    padding: 8px;
    font-size: 1rem;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--card-bg);
    color: var(--text);
  }

  .scale {
    margin: 4px 0 0;
    font-size: 0.85rem;
    color: var(--text-sub);
  }

  /* ----- 今の様子 ----- */
  .now {
    min-height: 56px;
    margin-bottom: 12px;
    padding: 12px 16px;
    background: var(--accent-light);
    border-radius: 10px;
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
    justify-content: center;
  }

  .now-message {
    margin: 0;
    text-align: center;
    color: var(--text-sub);
    font-size: 0.95rem;
  }

  .now-row {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    gap: 12px;
  }

  .now-time {
    font-size: 1.1rem;
    font-variant-numeric: tabular-nums;
  }

  /* 録音中の赤い丸 */
  .rec-dot {
    color: #d64545;
  }

  .now-note {
    font-size: 1.3rem;
    font-weight: bold;
    color: var(--accent);
  }

  .now-cents {
    margin-left: 8px;
    font-variant-numeric: tabular-nums;
  }

  /* ----- ずれの色（合っている＝緑、高い＝赤、低い＝青、分からない＝グレー） ----- */
  .ok {
    color: var(--accent);
  }

  .high {
    color: #d64545;
  }

  .low {
    color: #3a6fd8;
  }

  .none {
    color: var(--disabled);
  }

  /* ----- グラフ ----- */
  .graph-area {
    display: flex;
    margin-bottom: 12px;
    background: var(--card-bg);
    border: 1px solid var(--border);
    border-radius: 10px;
    overflow: hidden;
  }

  /* 縦の目盛りの欄は、縮まないようにする */
  .axis {
    flex: 0 0 auto;
    display: block;
  }

  /* グラフ本体は、残りの幅で横にスクロールする */
  .scroller {
    flex: 1;
    min-width: 0;
    overflow-x: auto;
  }

  .graph {
    display: block;
    cursor: pointer;
  }

  .graph-ok {
    fill: var(--accent-light);
  }

  .graph-grid {
    stroke: #e4e4e4;
    stroke-width: 1;
  }

  .graph-zero {
    stroke: var(--accent);
    stroke-width: 1;
  }

  .graph-divider {
    stroke: #c8c8c8;
    stroke-width: 1;
    stroke-dasharray: 2 3;
  }

  .graph-label {
    font-size: 10px;
    fill: var(--text-sub);
  }

  .note-label {
    font-size: 11px;
    fill: var(--text);
  }

  .graph-line {
    fill: none;
    stroke: #333333;
    stroke-width: 1.5;
    stroke-linejoin: round;
    stroke-linecap: round;
  }

  .graph-cursor {
    stroke: #e07a2f;
    stroke-width: 2;
  }

  /* ----- 再生とダウンロード ----- */
  .playback {
    display: flex;
    gap: 8px;
    margin-bottom: 12px;
  }

  .sub-button {
    flex: 1;
    padding: 10px;
    font-size: 1rem;
    text-align: center;
    text-decoration: none;
    border: 1px solid var(--accent);
    border-radius: 10px;
    background: var(--card-bg);
    color: var(--accent);
    cursor: pointer;
    box-sizing: border-box;
  }

  /* ----- エラーのメッセージ ----- */
  .error {
    margin: 0 0 12px;
    color: #d64545;
    font-size: 0.9rem;
  }

  /* ----- 録音・止めるボタン ----- */
  .play {
    display: block;
    width: 100%;
    padding: 16px;
    font-size: 1.2rem;
    font-weight: bold;
    border: none;
    border-radius: 12px;
    background: var(--accent);
    color: #ffffff;
    cursor: pointer;
  }

  .play.running {
    background: var(--card-bg);
    color: var(--accent);
    border: 2px solid var(--accent);
  }

  .play:disabled {
    opacity: 0.6;
    cursor: default;
  }
</style>
