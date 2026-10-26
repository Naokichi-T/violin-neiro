// ===== 録音のページの設定をブラウザに保存・読み込みする仕組み =====
// 選んだ音律と調を覚えておき、次に開いたときも同じ設定で始められるようにする。

// 調の id が正しいかを確かめる関数
import { getKey, DEFAULT_KEY_ID } from "./key.js";

// ブラウザに保存するときの名前（ほかのアプリの保存とぶつからないように、アプリ名を付ける）
const STORAGE_KEY = "violin-neiro-record-settings";

// 録音のページで選べる音律
//   id   ：tuning.js の音律の id
//   name ：画面に出す名前
export const RECORD_TEMPERAMENTS = [
  { id: "pythagorean", name: "ピタゴラス音律" },
  { id: "just", name: "純正律" },
];

// 設定の最初の値
//   temperamentId ：音律の id
//   keyId         ：調の id
export const DEFAULT_RECORD_SETTINGS = {
  temperamentId: "pythagorean",
  keyId: DEFAULT_KEY_ID,
};

/**
 * 保存しておいた設定を読み込む関数
 * 保存がないとき・読めないとき・おかしな値のときは、最初の値を使う。
 * @returns {{temperamentId: string, keyId: string}} 設定
 */
export function loadRecordSettings() {
  try {
    const text = localStorage.getItem(STORAGE_KEY);
    if (text === null) {
      return { ...DEFAULT_RECORD_SETTINGS };
    }

    const saved = JSON.parse(text);
    return {
      // 選べる音律のどれかでなければ、最初の値
      temperamentId: RECORD_TEMPERAMENTS.some((t) => t.id === saved.temperamentId) ? saved.temperamentId : DEFAULT_RECORD_SETTINGS.temperamentId,
      // 知らない id のときは getKey がハ長調を返すので、その id を使う
      keyId: getKey(saved.keyId).id,
    };
  } catch (error) {
    return { ...DEFAULT_RECORD_SETTINGS };
  }
}

/**
 * 設定をブラウザに保存する関数
 * @param {{temperamentId: string, keyId: string}} settings - 設定
 */
export function saveRecordSettings(settings) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch (error) {
    // プライベートモードなどで保存できないときは、諦める
  }
}
