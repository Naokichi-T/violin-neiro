// ===== マイクで音を聴いて、音程を調べ続ける仕組み =====
// マイクの音を少しずつ取り出し、そのたびに pitch.js で周波数を調べて、結果を知らせる。
//
// 流れ：
//   マイク → 音の入口（MediaStreamSource） → 波形を取り出す部品（Analyser）
//   → 画面の書き換えのたび（1秒に約60回）に波形を取り出す → detectPitch で周波数を求める
//   → 呼び出し元の関数（onPitch）に「周波数」と「時刻」を渡す

// 波形から周波数を調べる関数を読み込む
import { detectPitch } from "./pitch.js";

// ===== 設定値 =====

// 1回に取り出す波形の長さ（データの数）。2048 は 48000Hz で約0.04秒ぶん
// 長いほど低い音を正確に測れるが、変化への反応が遅くなる
const FFT_SIZE = 2048;

// ===== 動いている状態 =====

// 音を扱うための土台
let audioContext = null;

// マイクの音の流れ（止めるときに、マイクを切るために使う）
let stream = null;

// 音の入口の部品
let source = null;

// 波形を取り出す部品
let analyser = null;

// 取り出した波形を入れておく入れ物
let buffer = null;

// 次の「調べる」の予約番号（止めるときに予約を取り消すために使う）
let frameId = null;

/**
 * マイクをオンにして、音程を調べ続ける関数
 * 音程を調べるたびに onPitch(周波数, 時刻) を呼ぶ。
 * 周波数は、音が小さい・はっきりしないときは null になる。
 * 時刻は秒（ページを開いてからの経過時間）。
 * @param {(frequency: number|null, time: number) => void} onPitch - 調べた結果を受け取る関数
 * @returns {Promise<void>}
 * @throws マイクの使用を断られたときなどは、エラーになる（呼び出し元で受け止める）
 */
export async function startMicrophone(onPitch) {
  // 前のが動いていたら、止めてから始める
  stopMicrophone();

  // マイクを使わせてもらう
  // 音程を正しく測るため、ブラウザが自動でかける加工（エコー除去・雑音除去・音量の自動調整）は切る
  stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    },
  });

  // 音を扱う土台を作り、一時停止していたら動かす
  audioContext = new AudioContext();
  if (audioContext.state === "suspended") {
    await audioContext.resume();
  }

  // マイク → 波形を取り出す部品、とつなぐ（スピーカーにはつながないので、自分の音は鳴らない）
  source = audioContext.createMediaStreamSource(stream);
  analyser = audioContext.createAnalyser();
  analyser.fftSize = FFT_SIZE;
  source.connect(analyser);

  // 波形を入れる入れ物を用意する
  buffer = new Float32Array(analyser.fftSize);

  // 画面の書き換えのたびに呼ばれる関数：波形を取り出して周波数を調べ、結果を知らせる
  const loop = () => {
    // 止められたあとは何もしない
    if (analyser === null) {
      return;
    }

    analyser.getFloatTimeDomainData(buffer);
    const frequency = detectPitch(buffer, audioContext.sampleRate);

    // 時刻は、ミリ秒を秒に直して渡す
    onPitch(frequency, performance.now() / 1000);

    // 次の書き換えのときにも、また調べる
    frameId = requestAnimationFrame(loop);
  };

  loop();
}

/**
 * マイクをオフにして、音程を調べるのをやめる関数
 * 動いていないときに呼んでも、何もしない。
 */
export function stopMicrophone() {
  // 次の「調べる」の予約を取り消す
  if (frameId !== null) {
    cancelAnimationFrame(frameId);
    frameId = null;
  }

  // 部品のつながりを外す
  if (source !== null) {
    source.disconnect();
    source = null;
  }
  analyser = null;
  buffer = null;

  // マイクを切る（スマホの「マイク使用中」の表示も消える）
  if (stream !== null) {
    stream.getTracks().forEach((track) => track.stop());
    stream = null;
  }

  // 音の土台を閉じる
  if (audioContext !== null) {
    audioContext.close();
    audioContext = null;
  }
}
