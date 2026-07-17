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

// ---------- Bluefin(trade.bluefin.io)の取引履歴一覧(複数枚)スクショ ----------
//
// 「2026/7/7 14:39:09」のような日時見出しごとにブロックを区切り、各ブロック内から
// Symbol/Direction/Type/Price/Size/Fee/Realized PnL をラベル基準で抽出する。
// Realized PnLが0(または無し)のブロックは「オープン」、それ以外は「クローズ」とみなす。
export function parseBluefinBlocks(text) {
  if (!text) return [];
  const headerRe = /(\d{4})\/(\d{1,2})\/(\d{1,2})\s+(\d{1,2}):(\d{2}):(\d{2})/g;
  const marks = [];
  let hm;
  while ((hm = headerRe.exec(text))) {
    marks.push({ index: hm.index, y: hm[1], mo: hm[2], d: hm[3], h: hm[4], mi: hm[5], s: hm[6] });
  }
  if (marks.length === 0) return [];

  const trades = [];
  for (let i = 0; i < marks.length; i++) {
    const start = marks[i].index;
    const end = i + 1 < marks.length ? marks[i + 1].index : text.length;
    const block = text.slice(start, end);

    const dirMatch = block.match(/\b(Long|Short)\b/i);
    const sizeMatch = block.match(/Size[\s\S]{0,30}?([\d.]+)\s*([A-Z]{2,6})\b/i);
    if (!dirMatch || !sizeMatch) continue; // 最低限これが無いと信頼できないのでスキップ

    const priceMatch = block.match(/Price[\s\S]{0,30}?\$?([\d,]+\.?\d*)/i);

    // Fee と Realized PnL はUI上で同じ行に横並びになっており、それぞれの値も
    // 次の行に横並びで出てくる(例: "Fee Realized PnL" → "$0.2952 -$5.06")。
    // ラベルからただ最初に見つかる数値を拾うと、Feeの値をPnLと誤認するため、
    // 2つの値をまとめてペアで捉える。
    const feePnlMatch = block.match(/Fee[\s\S]{0,20}?Realized\s*PnL[\s\S]{0,10}?\$?([\d,]+\.?\d*)[\s\S]{0,10}?([+-]?\$?[\d,]+\.?\d*)/i);
    const feeMatch = feePnlMatch || block.match(/Fee[\s\S]{0,30}?\$?([\d,]+\.?\d*)/i);
    const pnlMatch = feePnlMatch ? { 1: feePnlMatch[2] } : block.match(/Realized\s*PnL[\s\S]{0,30}?([+-]?\$?[\d,]+\.?\d*)/i);

    const pnl = pnlMatch ? num(pnlMatch[1]) : null;
    const price = priceMatch ? num(priceMatch[1]) : null;
    const isOpen = pnl === 0 || pnl === null;

    trades.push({
      exchange: "Bluefin",
      symbol: sizeMatch[2].toUpperCase(),
      side: /short/i.test(dirMatch[1]) ? "short" : "long",
      entryPrice: isOpen ? price : null,
      exitPrice: isOpen ? null : price,
      size: num(sizeMatch[1]),
      leverage: null,
      pnl,
      fee: feeMatch ? num(feeMatch[1]) : null,
      date: `${marks[i].y}-${String(marks[i].mo).padStart(2, "0")}-${String(marks[i].d).padStart(2, "0")}`,
      time: `${marks[i].h}:${marks[i].mi}:${marks[i].s}`,
      status: isOpen ? "open" : "closed",
    });
  }
  return trades;
}

// ---------- MetaMask(Perps)のアクティビティ一覧(複数枚)スクショ ----------
//
// 注意:この画面には価格(建値/決済値)が一切表示されないため、entryPrice/exitPriceは
// 常にnullになる。「Closed long/short」の行だけを取引として拾い、表示されている
// 損益額をそのままpnlとする(「Opened」の行は開始時の手数料程度の小額でしかないため、
// 誤って組み合わせるリスクを避けて無視する)。日付は「Nov 4」のような見出しから、
// 直近の見出しを各取引に割り当てる(年は現在年と仮定し、未来になる場合は前年とする)。
const MONTH_MAP = { Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6, Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12 };

function isoFromMonthDay(mon, day) {
  const mIdx = MONTH_MAP[mon];
  if (!mIdx) return null;
  const now = new Date();
  let d = new Date(now.getFullYear(), mIdx - 1, Number(day));
  if (d.getTime() > now.getTime()) d = new Date(now.getFullYear() - 1, mIdx - 1, Number(day));
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

export function parseMetaMaskActivityBlocks(text) {
  if (!text) return [];

  const dateHeaderRe = /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2})\b/g;
  const headers = [];
  let dm;
  while ((dm = dateHeaderRe.exec(text))) {
    headers.push({ index: dm.index, iso: isoFromMonthDay(dm[1], dm[2]) });
  }
  const findDateFor = (idx) => {
    let best = null;
    for (const h of headers) {
      if (h.index <= idx) best = h;
      else break;
    }
    return best ? best.iso : null;
  };

  const entryRe = /(Opened|Closed)\s+(long|short)\b[\s\S]{0,40}?([\d.]+)\s*([A-Z]{2,6})\b[\s\S]{0,60}?([+-]?\$[\d,]+\.?\d*)/gi;
  const trades = [];
  let m;
  while ((m = entryRe.exec(text))) {
    const [, action, side, amount, symbol, dollar] = m;
    if (/opened/i.test(action)) continue;
    trades.push({
      exchange: "MetaMask",
      symbol: symbol.toUpperCase(),
      side: /short/i.test(side) ? "short" : "long",
      entryPrice: null,
      exitPrice: null,
      size: num(amount),
      leverage: null,
      pnl: num(dollar),
      fee: null,
      date: findDateFor(m.index),
      time: null,
      status: "closed",
    });
  }
  return trades;
}
