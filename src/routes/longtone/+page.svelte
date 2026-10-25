<script>
  // ===== ロングトーンのページ =====
  // 1つの音を長くのばし、その間の音程のずれとぶれを測って、グラフと点数で見せる

  import { onMount } from "svelte";

  // 音のデータを「ラ4」のような文字にする関数
  import { noteToText } from "#lib/score.js";

  // マイクのオン・オフ
  import { startMicrophone, stopMicrophone } from "#lib/microphone.js";

  // ロングトーンの計算
  import { OPEN_STRING_TARGETS, FREE_TARGET_ID, SKIP_SECONDS, SILENCE_SECONDS, MAX_SECONDS, getTargetFrequency, findNearestNote, getCents, getMedian, summarizeLongTone } from "#lib/longtone.js";

  // ===== 設定値 =====

  // これ以内のずれなら「合っている」とみなす（緑で表示する）幅（セント）
  const OK_CENTS = 5;

  // グラフの縦の目盛りの上限・下限（セント）。はみ出したら端に貼り付ける
  const GRAPH_CENTS = 50;

  // 計測中のグラフの横幅の最小値（秒）。はじめから横に引き伸ばされすぎないように
  const GRAPH_MIN_SECONDS = 4;

  // 前の音からこれ以上あいたら、グラフの線をいったん切る（秒）
  const GRAPH_GAP_SECONDS = 0.15;

  // グラフの大きさと、線を描く範囲（SVG の座標）
  const GRAPH_WIDTH = 320;
  const GRAPH_HEIGHT = 180;
  const PLOT_LEFT = 36;
  const PLOT_RIGHT = 312;
  const PLOT_TOP = 10;
  const PLOT_BOTTOM = 150;

  // ===== 画面の状態 =====

  // 選んでいる目標の id（'G3'・'D4'・'A4'・'E5'・'free'）
  let targetId = $state("A4");

  // 今の段階
  //   'idle'      ：まだ始めていない
  //   'waiting'   ：「始める」を押して、音が出るのを待っている
  //   'measuring' ：計測中
  //   'done'      ：計測が終わって、結果を表示している
  let status = $state("idle");

  // 計測した音の一覧（time は計測を始めてからの秒、frequency は周波数）
  let samples = $state([]);

  // 今回の目標の音のデータ（「自由」で、まだ決まっていないときは null）
  let targetNote = $state(null);

  // 今聞こえている音の周波数（聞こえていないときは null）
  let currentFrequency = $state(null);

  // 計測を始めてからの秒数
  let elapsed = $state(0);

  // 結果（計測が終わったら入る）
  let result = $state(null);

  // マイクが使えなかったときなどのメッセージ
  let errorMessage = $state("");

  // ===== 画面に出さない計測用の値 =====

  // 計測を始めた時刻（秒）
  let startTime = 0;

  // 最後に音が聞こえた時刻（秒）
  let lastHeardTime = 0;

  // 「自由」のときに、目標を決めるために集める出だしの音の周波数
  let freeCandidates = [];

  // ===== 計算する値 =====

  // 今回の目標の周波数（まだ決まっていないときは null）
  const targetFrequency = $derived(targetNote ? getTargetFrequency(targetNote) : null);

  // 今聞こえている音の、目標からのずれ（セント）。分からないときは null
  const currentCents = $derived(currentFrequency !== null && targetFrequency !== null ? getCents(currentFrequency, targetFrequency) : null);

  // 計測中かどうか（「始める」を押してから終わるまで）
  const running = $derived(status === "waiting" || status === "measuring");

  // グラフの横幅（秒）：計測中はのびていき、終わったら音の長さぴったりにする
  const graphSeconds = $derived(status === "done" && result ? Math.max(result.duration, 1) : Math.max(elapsed, GRAPH_MIN_SECONDS));

  // グラフの横の目盛りの間隔（秒）：横幅に合わせて、目盛りが混みすぎないようにする
  const tickStep = $derived(graphSeconds <= 10 ? 2 : graphSeconds <= 30 ? 5 : 10);

  // グラフの横の目盛り（秒）の一覧
  const ticks = $derived.by(() => {
    const list = [];
    for (let t = 0; t <= graphSeconds; t += tickStep) {
      list.push(t);
    }
    return list;
  });

  // グラフの線（SVG の path の d 属性）
  const graphPath = $derived(makeGraphPath(samples, targetFrequency, graphSeconds));

  // ===== 起動と後片付け =====

  onMount(() => {
    // ページを離れるときは、マイクを切る
    return () => {
      stopMicrophone();
    };
  });

  // ===== グラフの計算 =====

  /**
   * 秒を、グラフの横の位置（SVG の x 座標）に直す関数
   * @param {number} time - 秒
   * @param {number} seconds - グラフの横幅（秒）
   * @returns {number} x 座標
   */
  function timeToX(time, seconds) {
    return PLOT_LEFT + (time / seconds) * (PLOT_RIGHT - PLOT_LEFT);
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
   * 計測した音から、グラフの線（SVG の path）を作る関数
   * 音が途切れたところでは、線をいったん切る。
   * @param {{time: number, frequency: number}[]} list - 計測した音の一覧
   * @param {number|null} target - 目標の周波数（まだ決まっていないときは null）
   * @param {number} seconds - グラフの横幅（秒）
   * @returns {string} path の d 属性の文字（線がないときは空文字）
   */
  function makeGraphPath(list, target, seconds) {
    // 目標が決まるまでは、ずれが分からないので線を引かない
    if (target === null) {
      return "";
    }

    let path = "";
    let previousTime = null;

    for (const sample of list) {
      const x = timeToX(sample.time, seconds).toFixed(1);
      const y = centsToY(getCents(sample.frequency, target)).toFixed(1);

      // 最初の点、または前の点から時間があいたときは「ここから描き始める」（M）
      // それ以外は「前の点から線を引く」（L）
      if (previousTime === null || sample.time - previousTime > GRAPH_GAP_SECONDS) {
        path += `M${x},${y} `;
      } else {
        path += `L${x},${y} `;
      }
      previousTime = sample.time;
    }

    return path;
  }

  // ===== 計測の処理 =====

  /**
   * 「始める」を押したときの関数
   * 前回の結果を消して、マイクをオンにし、音が出るのを待つ。
   */
  async function start() {
    // 前回の結果を消す
    errorMessage = "";
    samples = [];
    result = null;
    freeCandidates = [];
    currentFrequency = null;
    elapsed = 0;

    // 目標の音を決める（「自由」のときは、弾き始めてから決める）
    const openString = OPEN_STRING_TARGETS.find((target) => target.id === targetId);
    targetNote = openString ? openString.note : null;

    status = "waiting";

    try {
      await startMicrophone(handlePitch);
    } catch (error) {
      // マイクの使用を断られた・マイクがないなど
      status = "idle";
      errorMessage = "マイクを使えませんでした。ブラウザの設定で、このページのマイクの使用を許可してください。";
    }
  }

  /**
   * マイクで音程を調べるたびに呼ばれる関数（1秒に約60回）
   * 音が出るのを待つ → 計測する → 音が途切れたら終わる、を進める。
   * @param {number|null} frequency - 周波数（音が小さい・はっきりしないときは null）
   * @param {number} now - 今の時刻（秒）
   */
  function handlePitch(frequency, now) {
    // ----- 音が出るのを待っているとき -----
    if (status === "waiting") {
      // まだ音が出ていなければ、待ち続ける
      if (frequency === null) {
        return;
      }
      // 音が出たので、ここから計測を始める
      status = "measuring";
      startTime = now;
      lastHeardTime = now;
    }

    // 計測中でなければ何もしない
    if (status !== "measuring") {
      return;
    }

    // 計測を始めてからの秒数
    const time = now - startTime;
    elapsed = time;

    if (frequency !== null) {
      // ----- 音が聞こえたとき：記録する -----
      lastHeardTime = now;
      currentFrequency = frequency;
      samples.push({ time, frequency });

      // 「自由」で目標がまだ決まっていないとき：出だしの音を集め、少したったら目標を決める
      if (targetNote === null) {
        freeCandidates.push(frequency);
        if (time >= SKIP_SECONDS) {
          targetNote = findNearestNote(getMedian(freeCandidates));
        }
      }
    } else {
      // ----- 音が聞こえないとき -----
      currentFrequency = null;
    }

    // しばらく音が聞こえない、または最長の時間になったら、終わりにする
    if (now - lastHeardTime >= SILENCE_SECONDS || time >= MAX_SECONDS) {
      finish();
    }
  }

  /**
   * 計測を終える関数（音が途切れたとき・「止める」を押したとき・最長の時間になったとき）
   * マイクを切って、結果を計算する。
   */
  function finish() {
    stopMicrophone();
    currentFrequency = null;

    // まだ音が出ていなかったとき（待っている途中で「止める」を押した）は、最初の状態に戻る
    if (status === "waiting") {
      status = "idle";
      return;
    }

    // 音を出していた長さ：始めてから、最後に音が聞こえたときまで
    const duration = lastHeardTime - startTime;

    // 「自由」で、目標が決まる前に終わったときは、集めた音から目標を決める
    if (targetNote === null && freeCandidates.length > 0) {
      targetNote = findNearestNote(getMedian(freeCandidates));
    }

    // 結果を計算する（$state.snapshot で、状態の入れ物からふつうの配列に取り出して渡す）
    result = targetNote !== null ? summarizeLongTone($state.snapshot(samples), getTargetFrequency(targetNote), duration) : null;

    status = "done";
  }

  /**
   * 「始める」「止める」ボタンを押したときの関数
   */
  function handleToggle() {
    if (running) {
      finish();
    } else {
      start();
    }
  }

  // ===== 表示用の関数 =====

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
</script>

<svelte:head>
  <title>ロングトーン｜バイオリン音色練習</title>
  <meta name="description" content="1つの音を長くのばして、音程のずれとぶれをグラフと点数で確かめるバイオリンの練習ページ" />
</svelte:head>

<!-- ===== ホームへ戻るリンクと見出し ===== -->
<a class="back" href="/">← ホーム</a>
<h1 class="title">ロングトーン</h1>
<p class="lead">「始める」を押してから弾き始めると、音が出た瞬間から測ります。音が途切れると終わります。</p>

<!-- ===== 目標の音を選ぶ ===== -->
<section class="row">
  <span class="label">目標</span>
  <div class="toggle-group" role="group" aria-label="目標の音">
    {#each OPEN_STRING_TARGETS as target (target.id)}
      <button type="button" class="toggle" aria-pressed={targetId === target.id} disabled={running} onclick={() => (targetId = target.id)}>
        {noteToText(target.note)}
      </button>
    {/each}
    <button type="button" class="toggle" aria-pressed={targetId === FREE_TARGET_ID} disabled={running} onclick={() => (targetId = FREE_TARGET_ID)}> 自由 </button>
  </div>
</section>

<!-- ===== 今の様子（目標の音・今のずれ・経過時間） ===== -->
<div class="now">
  {#if status === "idle"}
    <p class="now-message">目標を選んで「始める」を押してください</p>
  {:else if status === "waiting"}
    <p class="now-message">音を出してください</p>
  {:else}
    <div class="now-row">
      <!-- 目標の音（「自由」で決まる前は「判定中…」） -->
      <span class="now-target">
        {targetNote ? noteToText(targetNote) : "判定中…"}
        {#if targetFrequency !== null}
          <span class="now-hz">{targetFrequency.toFixed(1)} Hz</span>
        {/if}
      </span>
      <!-- 計測中は、今のずれを大きく出す -->
      {#if status === "measuring"}
        <span class="now-cents {centsClass(currentCents)}">
          {currentCents !== null ? formatCents(currentCents) : "−−"}
        </span>
      {/if}
    </div>
    {#if status === "measuring"}
      <p class="now-time">{elapsed.toFixed(1)} 秒</p>
    {/if}
  {/if}
</div>

<!-- ===== 音程のグラフ ===== -->
<svg class="graph" viewBox="0 0 {GRAPH_WIDTH} {GRAPH_HEIGHT}" role="img" aria-label="時間ごとの、目標からの音程のずれのグラフ">
  <!-- 点数に入れない出だしの部分を、うすいグレーで塗る -->
  <rect class="graph-skip" x={PLOT_LEFT} y={PLOT_TOP} width={timeToX(SKIP_SECONDS, graphSeconds) - PLOT_LEFT} height={PLOT_BOTTOM - PLOT_TOP} />

  <!-- 「合っている」範囲（±5セント）を、うすい緑で塗る -->
  <rect class="graph-ok" x={PLOT_LEFT} y={centsToY(OK_CENTS)} width={PLOT_RIGHT - PLOT_LEFT} height={centsToY(-OK_CENTS) - centsToY(OK_CENTS)} />

  <!-- 横の線と、縦の目盛りの数字（+50・+25・0・−25・−50） -->
  {#each [50, 25, 0, -25, -50] as value (value)}
    <line class={value === 0 ? "graph-zero" : "graph-grid"} x1={PLOT_LEFT} x2={PLOT_RIGHT} y1={centsToY(value)} y2={centsToY(value)} />
    <text class="graph-label" x={PLOT_LEFT - 4} y={centsToY(value) + 4} text-anchor="end">
      {value > 0 ? "+" + value : value === 0 ? "0" : "−" + Math.abs(value)}
    </text>
  {/each}

  <!-- 横の目盛りの数字（秒） -->
  {#each ticks as t (t)}
    <text class="graph-label" x={timeToX(t, graphSeconds)} y={PLOT_BOTTOM + 16} text-anchor="middle">
      {t}
    </text>
  {/each}
  <text class="graph-label" x={PLOT_RIGHT} y={GRAPH_HEIGHT - 2} text-anchor="end">秒</text>

  <!-- 音程の線 -->
  <path class="graph-line" d={graphPath} />
</svg>

<!-- ===== 結果 ===== -->
{#if status === "done"}
  <div class="result">
    {#if result === null}
      <p class="result-message">音程を測れませんでした。もう一度弾いてみてください。</p>
    {:else if result.tooShort}
      <p class="result-message">
        短すぎます（{result.duration.toFixed(1)}秒）。1秒以上のばしてください。
      </p>
    {:else}
      <p class="result-score"><span class="score-number">{result.score}</span> 点</p>
      <dl class="result-list">
        <dt>長さ</dt>
        <dd>{result.duration.toFixed(1)} 秒</dd>
        <dt>平均のずれ</dt>
        <dd class={centsClass(result.average)}>{formatCents(result.average)} セント</dd>
        <dt>ぶれの大きさ</dt>
        <dd>±{result.spread} セント</dd>
      </dl>
    {/if}
  </div>
{/if}

<!-- マイクが使えなかったときのメッセージ -->
{#if errorMessage}
  <p class="error">{errorMessage}</p>
{/if}

<!-- ===== 始める・止めるボタン ===== -->
<button type="button" class="play" class:running onclick={handleToggle}>
  {running ? "■ 止める" : "▶ 始める"}
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

  /* ----- 目標を選ぶ行 ----- */
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

  .toggle-group {
    flex: 1;
    display: flex;
    gap: 6px;
    /* 狭い画面でも、はみ出さないようにする */
    min-width: 0;
  }

  .toggle {
    flex: 1;
    /* 5つ並べても入るように、縮められるようにする */
    min-width: 0;
    padding: 8px 2px;
    font-size: 0.9rem;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--card-bg);
    color: var(--text);
    cursor: pointer;
  }

  /* 選ばれているボタンは緑にする */
  .toggle[aria-pressed="true"] {
    background: var(--accent);
    border-color: var(--accent);
    color: #ffffff;
    font-weight: bold;
  }

  /* 計測中は押せないので、少し薄くする */
  .toggle:disabled {
    opacity: 0.5;
    cursor: default;
  }

  /* ----- 今の様子 ----- */
  .now {
    /* 中身が変わっても高さが変わらないように、最低の高さを決めておく */
    min-height: 88px;
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
  }

  .now-row {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    gap: 12px;
  }

  .now-target {
    font-size: 1.6rem;
    font-weight: bold;
    color: var(--accent);
  }

  .now-hz {
    font-size: 0.9rem;
    font-weight: normal;
    color: var(--text-sub);
  }

  .now-cents {
    font-size: 2rem;
    font-weight: bold;
    /* 数字の幅をそろえて、数字が変わってもガタガタしないようにする */
    font-variant-numeric: tabular-nums;
  }

  .now-time {
    margin: 0;
    font-size: 0.9rem;
    color: var(--text-sub);
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
  .graph {
    display: block;
    width: 100%;
    height: auto;
    margin-bottom: 12px;
    background: var(--card-bg);
    border: 1px solid var(--border);
    border-radius: 10px;
  }

  .graph-skip {
    fill: #f0f0f0;
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

  .graph-label {
    font-size: 10px;
    fill: var(--text-sub);
  }

  .graph-line {
    fill: none;
    stroke: #333333;
    stroke-width: 1.5;
    stroke-linejoin: round;
    stroke-linecap: round;
  }

  /* ----- 結果 ----- */
  .result {
    margin-bottom: 12px;
    padding: 12px 16px;
    background: var(--card-bg);
    border: 1px solid var(--border);
    border-radius: 10px;
  }

  .result-message {
    margin: 0;
    color: var(--text-sub);
  }

  .result-score {
    margin: 0 0 8px;
    text-align: center;
    font-size: 1.1rem;
  }

  .score-number {
    font-size: 2.4rem;
    font-weight: bold;
    color: var(--accent);
  }

  /* 「長さ」「平均のずれ」「ぶれの大きさ」を、左に名前・右に値で並べる */
  .result-list {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 4px 16px;
    margin: 0;
  }

  .result-list dt {
    color: var(--text-sub);
  }

  .result-list dd {
    margin: 0;
    text-align: right;
    font-variant-numeric: tabular-nums;
  }

  /* ----- マイクが使えなかったときのメッセージ ----- */
  .error {
    margin: 0 0 12px;
    color: #d64545;
    font-size: 0.9rem;
  }

  /* ----- 始める・止めるボタン ----- */
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

  /* 計測中は、白地に緑の文字にして「止める」ボタンだと分かるようにする */
  .play.running {
    background: var(--card-bg);
    color: var(--accent);
    border: 2px solid var(--accent);
  }
</style>
