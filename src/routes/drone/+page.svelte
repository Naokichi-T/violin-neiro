<script>
  // ===== ドローンのページ =====
  // 調の主音（と5度の音）を鳴らし続けて、その響きに合わせて音程を練習する

  // ページのタイトル・説明文・OGP をまとめて出す部品
  import PageMeta from "#lib/PageMeta.svelte";

  import { onMount } from "svelte";

  // 調の一覧と、調に関する関数
  import { KEYS, getKey, getKeyMenuLabel, getScaleNames, getSignatureAccidentals } from "#lib/key.js";

  // 音のデータを「レ3」のような文字にする関数
  import { noteToText } from "#lib/score.js";

  // 音の周波数を計算する関数と、最初の音律（ピタゴラス音律）
  import { getFrequency, DEFAULT_TEMPERAMENT_ID } from "#lib/tuning.js";

  // ドローンを鳴らす・変える・止める関数
  import { startDrone, updateDrone, stopDrone } from "#lib/drone.js";

  // 画面が暗くならないようにする関数
  import { keepScreenOn, allowScreenOff } from "#lib/wakeLock.js";

  // 設定の保存・読み込み
  import { DEFAULT_DRONE_SETTINGS, loadDroneSettings, saveDroneSettings } from "#lib/droneSettings.js";

  // ===== 画面で選ぶ値 =====

  // 選んでいる調の id
  let keyId = $state(DEFAULT_DRONE_SETTINGS.keyId);

  // 5度の音も鳴らすか（false は主音だけ）
  let withFifth = $state(DEFAULT_DRONE_SETTINGS.withFifth);

  // 主音のオクターブ（3 が「低い」、4 が「高い」）
  let octave = $state(DEFAULT_DRONE_SETTINGS.octave);

  // 音量のつまみの値（0〜100）
  let volume = $state(DEFAULT_DRONE_SETTINGS.volume);

  // 今鳴らしているかどうか
  let playing = $state(false);

  // 保存しておいた設定を読み込み終わったかどうか
  // （読み込む前の最初の値で、保存を上書きしてしまわないようにするため）
  let loaded = $state(false);

  // ===== 選んだ値から計算する値 =====

  // 選んでいる調のデータ
  const key = $derived(getKey(keyId));

  // 調の音階（例：['レ', 'ミ', 'ファ♯', …]）
  const scaleNames = $derived(getScaleNames(key));

  // 主音の音のデータ（例：ニ長調・低いなら レ3）
  // 主音に付く♯・♭は、調号から分かる（例：変ロ長調のシには♭が付く）
  const tonicNote = $derived({
    step: key.tonicStep,
    accidental: getSignatureAccidentals(key.signature)[key.tonicStep],
    octave: octave,
  });

  // 5度の音の音のデータ（主音から音名を4つ進めた音。例：レ3 なら ラ3）
  // 長調・短調とも、主音の5度上の音は調号どおりの♯・♭で、ちょうど完全5度になる
  const fifthNote = $derived.by(() => {
    // 音名を4つ進める（シを越えたらドに戻り、オクターブが1つ上がる）
    const step = (key.tonicStep + 4) % 7;
    const fifthOctave = key.tonicStep + 4 >= 7 ? octave + 1 : octave;
    return {
      step: step,
      accidental: getSignatureAccidentals(key.signature)[step],
      octave: fifthOctave,
    };
  });

  // 主音と5度の音の周波数（ピタゴラス音律・ラ＝442Hz）
  // ピタゴラス音律は5度を 3/2 倍で積み重ねる音律なので、5度の音はちょうど主音の 3/2 倍になる
  const tonicFrequency = $derived(getFrequency(tonicNote, key, DEFAULT_TEMPERAMENT_ID));
  const fifthFrequency = $derived(getFrequency(fifthNote, key, DEFAULT_TEMPERAMENT_ID));

  // 鳴らす音の周波数の一覧（主音だけなら1つ、主音＋5度なら2つ）
  const frequencies = $derived(withFifth ? [tonicFrequency, fifthFrequency] : [tonicFrequency]);

  // ===== 起動と後片付け =====

  onMount(() => {
    // 保存しておいた設定を読み込んで、画面に反映する
    const saved = loadDroneSettings();
    keyId = saved.keyId;
    withFifth = saved.withFifth;
    octave = saved.octave;
    volume = saved.volume;
    loaded = true;

    // ページを離れるときに呼ばれる：音を止めて、画面が暗くなってもよい状態に戻す
    return () => {
      stopDrone();
      allowScreenOff();
    };
  });

  // ===== 値が変わったときの処理 =====

  // 鳴らしている途中で調・鳴らす音・高さ・音量を変えたら、止めずに音を切り替える
  $effect(() => {
    // 中で使う値を先に読んで、どれが変わってもこの処理が呼ばれるようにする
    const currentFrequencies = frequencies;
    const currentVolume = volume;

    if (playing) {
      updateDrone(currentFrequencies, currentVolume);
    }
  });

  // 設定が変わったら、ブラウザに保存する
  $effect(() => {
    // 中で使う値を先に読んで、どれが変わってもこの処理が呼ばれるようにする
    const settings = { keyId, withFifth, octave, volume };

    // 読み込みが終わるまでは保存しない（最初の値で上書きしないため）
    if (loaded) {
      saveDroneSettings(settings);
    }
  });

  // ===== ボタンの処理 =====

  /**
   * 「鳴らす」「止める」ボタンを押したときの関数
   * 鳴らしていなければ鳴らし始め、鳴らしていれば止める。
   */
  async function handleToggle() {
    if (playing) {
      stop();
    } else {
      await startDrone(frequencies, volume);
      playing = true;
      // 鳴らしている間は、画面が暗くならないようにする
      keepScreenOn();
    }
  }

  /**
   * ドローンを止める関数
   */
  function stop() {
    stopDrone();
    playing = false;
    // 画面が暗くなってもよい状態に戻す
    allowScreenOff();
  }

  /**
   * 周波数を、画面に出す文字にする関数
   * @param {number} frequency - 周波数（Hz）
   * @returns {string} 小数第1位までの文字（例：'147.3'）
   */
  function formatHz(frequency) {
    return frequency.toFixed(1);
  }
</script>

<!-- ページのタイトル・説明文・OGP（リンクを送ったときに出る画像など） -->
<PageMeta title="ドローン｜バイオリン音色練習" description="調の主音（と5度の音）を鳴らし続けて、響きで音程を合わせるバイオリンの練習ページ。ピタゴラス音律・ラ＝442Hz。" path="/drone" />

<!-- ===== ホームへ戻るリンクと見出し ===== -->
<a class="back" href="/">← ホーム</a>
<h1 class="title">ドローン</h1>
<p class="lead">音を鳴らし続けながら音階や曲を弾き、響きのうなり（ワンワンという揺れ）が消える高さを探します。</p>

<!-- ===== 調を選ぶ ===== -->
<section class="row">
  <label class="label" for="key-select">調</label>
  <div class="field">
    <select id="key-select" class="select" bind:value={keyId}>
      {#each KEYS as k (k.id)}
        <option value={k.id}>{getKeyMenuLabel(k)}</option>
      {/each}
    </select>
    <!-- 選んだ調の音階を小さく表示する（どの音に♯・♭が付くかの確認用） -->
    <p class="scale">{scaleNames.join(" ")}</p>
  </div>
</section>

<!-- ===== 鳴らす音を選ぶ（主音だけ／主音＋5度） ===== -->
<section class="row">
  <span class="label">鳴らす音</span>
  <div class="toggle-group" role="group" aria-label="鳴らす音">
    <button type="button" class="toggle" aria-pressed={!withFifth} onclick={() => (withFifth = false)}> 主音 </button>
    <button type="button" class="toggle" aria-pressed={withFifth} onclick={() => (withFifth = true)}> 主音＋5度 </button>
  </div>
</section>

<!-- ===== 高さを選ぶ（低い／高い） ===== -->
<section class="row">
  <span class="label">高さ</span>
  <div class="toggle-group" role="group" aria-label="高さ">
    <button type="button" class="toggle" aria-pressed={octave === 3} onclick={() => (octave = 3)}> 低い </button>
    <button type="button" class="toggle" aria-pressed={octave === 4} onclick={() => (octave = 4)}> 高い </button>
  </div>
</section>

<!-- ===== 今鳴らす音の名前と周波数 ===== -->
<div class="now">
  <div class="now-note">
    <span class="now-name">{noteToText(tonicNote)}</span>
    <span class="now-hz">{formatHz(tonicFrequency)} Hz</span>
  </div>
  {#if withFifth}
    <div class="now-note now-fifth">
      <span class="now-name">＋ {noteToText(fifthNote)}</span>
      <span class="now-hz">{formatHz(fifthFrequency)} Hz</span>
    </div>
  {/if}
</div>

<!-- ===== 音量 ===== -->
<section class="row">
  <label class="label" for="volume">音量</label>
  <div class="field volume-field">
    <input id="volume" class="slider" type="range" min="0" max="100" step="1" bind:value={volume} />
    <span class="volume-value">{volume}</span>
  </div>
</section>

<!-- ===== 鳴らす・止めるボタン ===== -->
<button type="button" class="play" class:playing onclick={handleToggle}>
  {playing ? "■ 止める" : "▶ 鳴らす"}
</button>

<!-- iPhone の消音モード（横のスイッチ）がオンだと、ブラウザの音が出ないことがあるので、その案内（violin-pitch と同じ） -->
<p class="note">iPhone で音が出ないときは、消音モードを解除してから、ページを開き直してください。</p>

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
    /* 名前の幅をそろえて、右側の選ぶ部分の左端をそろえる */
    flex: 0 0 4.5em;
    padding-top: 8px;
    font-size: 0.95rem;
    color: var(--text-sub);
  }

  .field {
    /* 残りの幅をすべて使う */
    flex: 1;
    /* 中身が長くても、はみ出さずに縮められるようにする */
    min-width: 0;
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

  /* 音階の小さな表示 */
  .scale {
    margin: 4px 0 0;
    font-size: 0.85rem;
    color: var(--text-sub);
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

  /* 選ばれているボタンは緑にする */
  .toggle[aria-pressed="true"] {
    background: var(--accent);
    border-color: var(--accent);
    color: #ffffff;
    font-weight: bold;
  }

  /* ----- 今鳴らす音の表示 ----- */
  .now {
    margin: 8px 0 20px;
    padding: 16px;
    background: var(--accent-light);
    border-radius: 10px;
    text-align: center;
  }

  .now-note {
    display: flex;
    justify-content: center;
    align-items: baseline;
    gap: 12px;
  }

  .now-name {
    font-size: 1.8rem;
    font-weight: bold;
    color: var(--accent);
  }

  .now-hz {
    font-size: 1rem;
    color: var(--text-sub);
  }

  /* 5度の音は少し小さく表示する */
  .now-fifth .now-name {
    font-size: 1.3rem;
  }

  /* ----- 音量のつまみ ----- */
  .volume-field {
    display: flex;
    align-items: center;
    gap: 8px;
    padding-top: 6px;
  }

  .slider {
    flex: 1;
    /* つまみの色をアクセントの緑にする */
    accent-color: var(--accent);
  }

  .volume-value {
    /* 数字の幅をそろえて、数字が変わってもつまみの長さが変わらないようにする */
    width: 2.5em;
    text-align: right;
    font-variant-numeric: tabular-nums;
    color: var(--text-sub);
  }

  /* ----- 鳴らす・止めるボタン ----- */
  .play {
    display: block;
    width: 100%;
    margin-top: 8px;
    padding: 16px;
    font-size: 1.2rem;
    font-weight: bold;
    border: none;
    border-radius: 12px;
    background: var(--accent);
    color: #ffffff;
    cursor: pointer;
  }

  /* 鳴らしている間は、白地に緑の文字にして「止める」ボタンだと分かるようにする */
  .play.playing {
    background: var(--card-bg);
    color: var(--accent);
    border: 2px solid var(--accent);
  }

  /* ----- iPhone の消音モードの案内 ----- */
  .note {
    margin: 12px 0 0;
    font-size: 0.8rem;
    color: var(--text-sub);
  }
</style>
