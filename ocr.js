// 無料OCR(Tesseract.js) + 正規表現によるスクショ読み取りユーティリティ。
// App.jsx の「レートスクショ」「取引スクショ」読み取り機能から、
// 有料のClaude API解析より先に呼ばれる。ここで十分な情報が取れなければ
// 呼び出し側がAI解析にフォールバックする。

import { createWorker } from "tesseract.js";

// Tesseract のワーカーは初期化コストが高いので使い回す(英数字+日本語)。
let workerPromise = null;
function getWorker() {
  if (!workerPromise) {
    workerPromise = createWorker(["eng", "jpn"]);
  }
  return workerPromise;
}

export async function ocrImage(file) {
  const worker = await getWorker();
  const {
    data: { text },
  } = await worker.recognize(file);
  return text || "";
}

function num(s) {
  if (s === null || s === undefined) return null;
  const v = parseFloat(String(s).replace(/,/g, "").replace(/\$/g, ""));
  return Number.isNaN(v) ? null : v;
}

// ---------- 為替レート(USD/JPY)スクショ ----------
//
// 「1ドル=何円」の数値(だいたい80〜260円のレンジ)を拾う。
// USD/JPYやドル円といった目印の近くにある数値を優先し、
// それが無ければ「レンジ内の数値がちょうど1つだけ」の場合のみ採用する
// (複数候補がある=曖昧なので呼び出し側でAIにフォールバックさせる)。
export function parseRateFromText(text) {
  if (!text) return { rate: null, date: null };
  const cleaned = text.replace(/,/g, "");

  let rate = null;
  const cueRegex = /(?:USD\s*\/?\s*JPY|ドル\s*\/?\s*円|米ドル\s*\/?\s*円)[^\d]{0,15}(\d{2,3}\.\d{1,3})/i;
  const cueMatch = cleaned.match(cueRegex);
  if (cueMatch) {
    rate = parseFloat(cueMatch[1]);
  } else {
    const numRegex = /\b(\d{2,3}\.\d{1,3})\b/g;
    const candidates = [];
    let m;
    while ((m = numRegex.exec(cleaned))) {
      const v = parseFloat(m[1]);
      if (v >= 80 && v <= 260) candidates.push(v);
    }
    if (candidates.length === 1) rate = candidates[0];
  }

  let date = null;
  const isoMatch = cleaned.match(/(20\d{2})[-/](\d{1,2})[-/](\d{1,2})/);
  if (isoMatch) {
    const [, y, mo, d] = isoMatch;
    date = `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  } else {
    const jpMatch = cleaned.match(/(\d{1,2})月(\d{1,2})日/);
    if (jpMatch) {
      const [, mo, d] = jpMatch;
      date = `${new Date().getFullYear()}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    }
  }

  return { rate: rate && rate > 0 ? rate : null, date };
}

// ---------- パーペチュアル取引スクショ(1枚1トレード想定) ----------
//
// 「銘柄」「ロング/ショート」「損益」の3つが正規表現で拾えた場合のみ
// 信頼して採用する。複数取引が並ぶ一覧画面や、レイアウトが特殊で
// 拾いきれない場合はnullを返し、呼び出し側にAIへフォールバックさせる。

const SYMBOL_REGEX = /\b([A-Z]{2,10}[-/]?(?:USDT|USDC|PERP|USD))\b/;
const SIDE_REGEX = /\b(long|short|ロング|ショート)\b/i;
const PNL_REGEX = /(?:PNL|P&L|損益)\D{0,10}([+\-]?\$?-?\d[\d,]*\.?\d*)/i;
const ENTRY_REGEX = /(?:entry price|entry|建値|エントリー)\D{0,10}(\d[\d,]*\.?\d*)/i;
const EXIT_REGEX = /(?:exit price|exit|決済価格|クローズ価格)\D{0,10}(\d[\d,]*\.?\d*)/i;
const SIZE_REGEX = /(?:size|数量|枚数)\D{0,10}(\d[\d,]*\.?\d*)/i;
const LEVERAGE_REGEX = /(\d{1,3})\s*[xX×]/;
const FEE_REGEX = /(?:fee|手数料)\D{0,10}(\d[\d,]*\.?\d*)/i;
const DATE_REGEX = /(20\d{2})[-/](\d{1,2})[-/](\d{1,2})/;
const TIME_REGEX = /\b(\d{1,2}:\d{2}(?::\d{2})?\s*(?:AM|PM)?)\b/i;

export function parseTradeFromText(text) {
  if (!text) return null;

  const symbolMatch = text.match(SYMBOL_REGEX);
  const sideMatch = text.match(SIDE_REGEX);
  const pnlMatch = text.match(PNL_REGEX);
  if (!symbolMatch || !sideMatch || !pnlMatch) return null;

  const sideRaw = sideMatch[1].toLowerCase();
  const side = /short|ショート/.test(sideRaw) ? "short" : "long";

  const dateMatch = text.match(DATE_REGEX);
  const date = dateMatch ? `${dateMatch[1]}-${String(dateMatch[2]).padStart(2, "0")}-${String(dateMatch[3]).padStart(2, "0")}` : null;
  const timeMatch = text.match(TIME_REGEX);

  return {
    exchange: null,
    symbol: symbolMatch[1].replace(/[-/]/g, ""),
    side,
    entryPrice: num((text.match(ENTRY_REGEX) || [])[1]),
    exitPrice: num((text.match(EXIT_REGEX) || [])[1]),
    size: num((text.match(SIZE_REGEX) || [])[1]),
    leverage: num((text.match(LEVERAGE_REGEX) || [])[1]),
    pnl: num(pnlMatch[1]),
    fee: num((text.match(FEE_REGEX) || [])[1]),
    date,
    time: timeMatch ? timeMatch[1] : null,
    status: /open|保有中/i.test(text) ? "open" : "closed",
  };
}
