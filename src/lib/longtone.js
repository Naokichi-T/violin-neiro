// ===== ロングトーンの計算 =====
// 目標の音の決め方、目標からのずれ（セント）、結果（平均のずれ・ぶれの大きさ・点数）の計算をまとめる。
// 画面のこと（表示やボタン）はここには書かず、計算だけにしておく。

// 周波数の計算（ピタゴラス音律）に使う
import { getFrequency } from "./tuning.js";
import { getKey, DEFAULT_KEY_ID } from "./key.js";

// ===== 設定値 =====

// このアプリで使う音律（ピタゴラス音律で固定）
const TEMPERAMENT_ID = "pythagorean";

// 出だしの何秒を点数に入れないか（グラフには出す）。弾き始めは音が安定しにくいため
export const SKIP_SECONDS = 0.3;

// 何秒より短いと点数を出さないか
export const MIN_SECONDS = 1;

// 何秒続けて音が取れなくなったら終わりにするか（弓の返しなどの一瞬の途切れでは終わらない）
export const SILENCE_SECONDS = 0.5;

// 最長で何秒まで測るか（止め忘れたときのため）
export const MAX_SECONDS = 60;

// 目標から何セント以上ずれた音は、測り間違い（1オクターブ違いなど）とみなして結果の計算から外すか
const OUTLIER_CENTS = 100;

// 目標の候補（開放弦の4本）。ピタゴラス音律では、開放弦の高さそのものになる
//   id   ：区別するための名前
//   note ：音のデータ（step は音名の番号、accidental は♯♭、octave はオクターブ）
export const OPEN_STRING_TARGETS = [
  { id: "G3", note: { step: 4, accidental: 0, octave: 3 } }, // ソ3（G線）
  { id: "D4", note: { step: 1, accidental: 0, octave: 4 } }, // レ4（D線）
  { id: "A4", note: { step: 5, accidental: 0, octave: 4 } }, // ラ4（A線）
  { id: "E5", note: { step: 2, accidental: 0, octave: 5 } }, // ミ5（E線）
];

// 「自由」を表す id
export const FREE_TARGET_ID = "free";

// 半音の番号（0〜11、ドから数える）ごとの、音名の番号と♯の有無（♯で呼ぶ）
// 例：1 は ド♯（音名の番号 0、♯1つ）
const SEMITONE_TO_NOTE = [
  { step: 0, accidental: 0 }, // ド
  { step: 0, accidental: 1 }, // ド♯
  { step: 1, accidental: 0 }, // レ
  { step: 1, accidental: 1 }, // レ♯
  { step: 2, accidental: 0 }, // ミ
  { step: 3, accidental: 0 }, // ファ
  { step: 3, accidental: 1 }, // ファ♯
  { step: 4, accidental: 0 }, // ソ
  { step: 4, accidental: 1 }, // ソ♯
  { step: 5, accidental: 0 }, // ラ
  { step: 5, accidental: 1 }, // ラ♯
  { step: 6, accidental: 0 }, // シ
];

/**
 * 音のデータの周波数を求める関数（ピタゴラス音律・ラ＝442Hz）
 * @param {{step: number, accidental: number, octave: number}} note - 音のデータ
 * @returns {number} 周波数（Hz）
 */
export function getTargetFrequency(note) {
  // ピタゴラス音律では調は使わないが、関数の形に合わせて調（ハ長調）を渡しておく
  return getFrequency(note, getKey(DEFAULT_KEY_ID), TEMPERAMENT_ID);
}

/**
 * 周波数に一番近い音（ピタゴラス音律）を探す関数（「自由」のときに目標を決めるために使う）
 * まず平均律で一番近い半音を求め、その音のデータを作る。
 * （ピタゴラス音律と平均律の差は大きくても十数セントなので、近い音の選び方はほぼ同じになる）
 * @param {number} frequency - 周波数（Hz）
 * @returns {{step: number, accidental: number, octave: number}} 一番近い音の音のデータ
 */
export function findNearestNote(frequency) {
  // 音番号（ラ4 が 69、半音ごとに1ずつ）に直して、四捨五入する
  const noteNumber = Math.round(69 + 12 * Math.log2(frequency / 442));

  // オクターブと、オクターブの中の半音の番号（0〜11）に分ける（ド4 が 60）
  const octave = Math.floor(noteNumber / 12) - 1;
  const semitone = noteNumber - (octave + 1) * 12;

  return { ...SEMITONE_TO_NOTE[semitone], octave };
}

/**
 * 弾いた音が、目標から何セントずれているかを計算する関数
 * セントは、半音を100に分けた音程の単位（1オクターブが1200セント）。
 * @param {number} frequency - 弾いた音の周波数（Hz）
 * @param {number} targetFrequency - 目標の周波数（Hz）
 * @returns {number} ずれ（セント）。プラスは高い、マイナスは低い
 */
export function getCents(frequency, targetFrequency) {
  return 1200 * Math.log2(frequency / targetFrequency);
}

/**
 * いくつかの数の、真ん中の値（中央値）を求める関数
 * 「自由」で出だしの音から目標を決めるときに、ときどき混ざる測り間違いに引っぱられないように使う。
 * @param {number[]} values - 数の配列（1つ以上）
 * @returns {number} 中央値
 */
export function getMedian(values) {
  // 元の配列を変えないように、コピーしてから小さい順に並べる
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);

  // 個数が奇数なら真ん中の1つ、偶数なら真ん中の2つの平均
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * ロングトーンの結果を計算する関数
 * @param {{time: number, frequency: number}[]} samples - 計測した音（time は計測を始めてからの秒）
 * @param {number} targetFrequency - 目標の周波数（Hz）
 * @param {number} duration - 音を出していた長さ（秒）
 * @returns {{duration: number, tooShort: boolean, average: number, spread: number, score: number}|null}
 *   duration ：長さ（秒）
 *   tooShort ：短すぎて点数を出さないとき true
 *   average  ：平均のずれ（セント、整数）
 *   spread   ：ぶれの大きさ（セント、整数。標準偏差）
 *   score    ：点数（0〜100）
 *   点数に使える音が1つもないときは null
 */
export function summarizeLongTone(samples, targetFrequency, duration) {
  // 短すぎるときは、点数を出さない
  if (duration < MIN_SECONDS) {
    return { duration, tooShort: true, average: 0, spread: 0, score: 0 };
  }

  // 出だしを除き、ずれ（セント）に直す。大きく外れたもの（測り間違い）は外す
  const cents = samples
    .filter((sample) => sample.time >= SKIP_SECONDS)
    .map((sample) => getCents(sample.frequency, targetFrequency))
    .filter((value) => Math.abs(value) < OUTLIER_CENTS);

  if (cents.length === 0) {
    return null;
  }

  // 平均のずれ：全部のずれを足して、個数で割る（全体として高いか低いか）
  const average = cents.reduce((sum, value) => sum + value, 0) / cents.length;

  // ぶれの大きさ（標準偏差）：平均からの離れ具合を2乗して平均し、平方根をとる（どれだけ揺れたか）
  const variance = cents.reduce((sum, value) => sum + (value - average) ** 2, 0) / cents.length;
  const spread = Math.sqrt(variance);

  // 点数：100 から「平均のずれの大きさ」と「ぶれの大きさの2倍」を引き、0〜100 に収める
  const rawScore = 100 - Math.abs(average) - spread * 2;
  const score = Math.round(Math.min(Math.max(rawScore, 0), 100));

  return {
    duration,
    tooShort: false,
    average: Math.round(average),
    spread: Math.round(spread),
    score,
  };
}
