import React, { useState, useEffect, useRef, useCallback } from "react";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  BarChart,
  Bar,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ReferenceLine,
} from "recharts";
import { Upload, Plus, Trash2, Pencil, Check, X, Loader2, TrendingUp, TrendingDown, ImageOff, RefreshCw, Camera, ChevronDown, ChevronRight, Settings } from "lucide-react";
import { storage } from "./storage";
import { ocrImage, parseRateFromText, parseTradeFromText } from "./ocr";

// ---------- helpers ----------

const uid = () => Math.random().toString(36).slice(2, 10);

const fmt = (n, digits = 2) => {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  return Number(n).toLocaleString("ja-JP", {
    minimumFractionDigits: 0,
    maximumFractionDigits: digits,
  });
};

const fmtUsd = (n) => {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  const sign = n > 0 ? "+" : "";
  return `${sign}$${fmt(n)}`;
};

const fmtJpy = (n, rate) => {
  if (n === null || n === undefined || Number.isNaN(n) || !rate) return null;
  const yen = n * rate;
  const sign = yen > 0 ? "+" : "";
  return `${sign}¥${Math.round(yen).toLocaleString("ja-JP")}`;
};

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result.split(",")[1]);
    r.onerror = () => reject(new Error("read failed"));
    r.readAsDataURL(file);
  });
}

function isoFromDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// parses pasted historical-rate tables (e.g. copied from investing.com's
// "ヒストリカルデータ" page): lines like "2026年7月10日  161.70  162.38 ..."
// -> { "2026-07-10": 161.70, ... }. Takes the first number after the date
// (the 終値/close column) as the rate for that day.
function parseRateTableText(text) {
  const result = {};
  let count = 0;
  const re = /(\d{4})年(\d{1,2})月(\d{1,2})日\s*[\t ]+([\d.]+)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const [, y, mo, d, rateStr] = m;
    const iso = `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    const rate = Number(rateStr);
    if (!Number.isNaN(rate) && rate > 0) {
      result[iso] = rate;
      count++;
    }
  }
  // also support plain ISO / slash dates: "2026-07-10  161.70" or "2026/07/10  161.70"
  const re2 = /(\d{4})[-/](\d{1,2})[-/](\d{1,2})\s*[\t ]+([\d.]+)/g;
  while ((m = re2.exec(text)) !== null) {
    const [, y, mo, d, rateStr] = m;
    const iso = `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    if (result[iso] !== undefined) continue; // don't double count from the two regexes
    const rate = Number(rateStr);
    if (!Number.isNaN(rate) && rate > 0) {
      result[iso] = rate;
      count++;
    }
  }
  return { rates: result, count };
}

// best-effort: turn the freeform date text (from a screenshot or manual entry)
// into an ISO yyyy-mm-dd so we can look up that day's exchange rate.
function parseTradeDateISO(dateStr) {
  if (!dateStr) return null;
  const s = String(dateStr).trim();
  const isoMatch = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (isoMatch) return `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`;

  const hasYear = /\b(19|20)\d{2}\b/.test(s);
  const now = new Date();
  const directParse = new Date(s);
  if (hasYear && !Number.isNaN(directParse.getTime())) {
    return isoFromDate(directParse);
  }

  // no year in the text (e.g. "Jun 8") — assume current year, and if that
  // lands in the future, it must have been last year instead.
  const guess = new Date(`${s} ${now.getFullYear()}`);
  if (!Number.isNaN(guess.getTime())) {
    if (guess.getTime() > now.getTime()) guess.setFullYear(now.getFullYear() - 1);
    return isoFromDate(guess);
  }
  return null;
}

// "2026-06-08" -> "2026-W23" (ISO 8601 week numbering, Monday-start weeks)
function isoWeekKey(iso) {
  const d = new Date(`${iso}T00:00:00`);
  const target = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = target.getUTCDay() || 7;
  target.setUTCDate(target.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(target.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((target - yearStart) / 86400000) + 1) / 7);
  return `${target.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
}

// parses "14:32", "2:32 PM", "02:32:11" etc. into 24h h/m/s, or null if unrecognized
function parseClockTime(timeStr) {
  if (!timeStr) return null;
  const s = String(timeStr).trim();
  const m = s.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp][Mm])?$/);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  const sec = m[3] ? parseInt(m[3], 10) : 0;
  const ampm = m[4] ? m[4].toUpperCase() : null;
  if (ampm === "PM" && h < 12) h += 12;
  if (ampm === "AM" && h === 12) h = 0;
  if (h > 23 || min > 59 || sec > 59) return null;
  return { h, m: min, s: sec };
}

// combines an ISO date with a freeform time string into an epoch-ms timestamp, if possible
function buildTimestamp(iso, timeStr) {
  if (!iso) return null;
  const t = parseClockTime(timeStr);
  if (!t) return null;
  const d = new Date(`${iso}T${String(t.h).padStart(2, "0")}:${String(t.m).padStart(2, "0")}:${String(t.s).padStart(2, "0")}`);
  return Number.isNaN(d.getTime()) ? null : d.getTime();
}

const EMPTY_TRADE = () => ({
  id: uid(),
  exchange: "",
  symbol: "",
  side: "long",
  entryPrice: null,
  exitPrice: null,
  size: null,
  leverage: null,
  pnl: null,
  fee: null,
  date: "",
  status: "closed",
});

const STORAGE_KEY = "perp-tracker:trades";
const API_KEY_STORAGE_KEY = "perp-tracker:anthropic-api-key";
const RATE_STORAGE_KEY = "perp-tracker:usdjpy";
const HIST_RATE_STORAGE_KEY = "perp-tracker:usdjpy-history";

// ---------- main app ----------

export default function App() {
  const [trades, setTrades] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadStatus, setUploadStatus] = useState("");
  const [uploadError, setUploadError] = useState("");
  const [editingId, setEditingId] = useState(null);
  const [draft, setDraft] = useState(null);
  const fileInputRef = useRef(null);

  // ---------- Anthropic API key ----------
  // The screenshot-reading features call the Claude API directly from the
  // browser. Inside claude.ai's artifact sandbox this is auto-authenticated;
  // as a standalone app it needs your own key. Get one at
  // https://console.anthropic.com/settings/keys — it's stored only in this
  // browser's localStorage, never sent anywhere except api.anthropic.com.
  const [apiKey, setApiKey] = useState("");
  const [showApiKeyInput, setShowApiKeyInput] = useState(false);
  const [apiKeyDraft, setApiKeyDraft] = useState("");

  useEffect(() => {
    (async () => {
      const res = await storage.get(API_KEY_STORAGE_KEY, false);
      if (res && res.value) setApiKey(res.value);
    })();
  }, []);

  const saveApiKey = async () => {
    const v = apiKeyDraft.trim();
    setApiKey(v);
    setShowApiKeyInput(false);
    await storage.set(API_KEY_STORAGE_KEY, v, false);
  };

  const anthropicHeaders = () => ({
    "Content-Type": "application/json",
    "x-api-key": apiKey,
    "anthropic-version": "2023-06-01",
    "anthropic-dangerous-direct-browser-access": "true",
  });

  const [tzMode, setTzMode] = useState("jst"); // jst | utc — applies to timestamps we know are true UTC (wallet-fetched trades)

  // formats a true-UTC epoch ms timestamp as "YYYY-MM-DD HH:MM <TZ>" in the selected timezone
  const formatTsInTz = (ts, tz) => {
    const offsetMs = tz === "jst" ? 9 * 3600 * 1000 : 0;
    const shifted = new Date(ts + offsetMs);
    const iso = shifted.toISOString();
    return `${iso.slice(0, 10)} ${iso.slice(11, 16)} ${tz === "jst" ? "JST" : "UTC"}`;
  };

  const [rate, setRate] = useState(null);
  const [rateUpdatedAt, setRateUpdatedAt] = useState(null);
  const [rateLoading, setRateLoading] = useState(false);
  const [rateFetchFailed, setRateFetchFailed] = useState(false);
  const [rateEditing, setRateEditing] = useState(false);
  const [rateInput, setRateInput] = useState("");

  const [currencyMode, setCurrencyMode] = useState("usd"); // usd | jpy_now | jpy_hist
  const [histRates, setHistRates] = useState({}); // isoDate -> rate | null (null = fetch failed)

  // load persisted trades
  useEffect(() => {
    (async () => {
      try {
        const res = await storage.get(STORAGE_KEY, false);
        if (res && res.value) {
          const parsed = JSON.parse(res.value);
          if (Array.isArray(parsed)) setTrades(parsed);
        }
      } catch (e) {
        // no data yet, ignore
      } finally {
        setLoaded(true);
      }
    })();
  }, []);

  // load cached rate, then refresh live
  useEffect(() => {
    (async () => {
      try {
        const res = await storage.get(RATE_STORAGE_KEY, false);
        if (res && res.value) {
          const parsed = JSON.parse(res.value);
          if (parsed && typeof parsed.rate === "number") {
            setRate(parsed.rate);
            setRateUpdatedAt(parsed.updatedAt || null);
          }
        }
      } catch (e) {
        // no cached rate yet
      }
      fetchLiveRate();
    })();
  }, []);

  const fetchLiveRate = async () => {
    setRateLoading(true);
    setRateFetchFailed(false);
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 6000);
      const res = await fetch("https://open.er-api.com/v6/latest/USD", { signal: controller.signal });
      clearTimeout(timeout);
      const data = await res.json();
      const jpy = data && data.rates && data.rates.JPY;
      if (typeof jpy === "number") {
        const now = new Date().toISOString();
        setRate(jpy);
        setRateUpdatedAt(now);
        try {
          await storage.set(RATE_STORAGE_KEY, JSON.stringify({ rate: jpy, updatedAt: now, source: "live" }), false);
        } catch (e) {
          console.error("rate save failed", e);
        }
      } else {
        setRateFetchFailed(true);
      }
    } catch (e) {
      console.error("rate fetch failed", e);
      setRateFetchFailed(true);
    } finally {
      setRateLoading(false);
    }
  };

  const saveManualRate = async () => {
    const v = Number(rateInput);
    if (!v || Number.isNaN(v) || v <= 0) {
      setRateEditing(false);
      return;
    }
    const now = new Date().toISOString();
    setRate(v);
    setRateUpdatedAt(now);
    setRateEditing(false);
    try {
      await storage.set(RATE_STORAGE_KEY, JSON.stringify({ rate: v, updatedAt: now, source: "manual" }), false);
    } catch (e) {
      console.error("rate save failed", e);
    }
  };

  // ---------- rate from screenshot ----------

  const [rateShotLoading, setRateShotLoading] = useState(false);
  const [rateShotError, setRateShotError] = useState("");
  const [rateShotStatus, setRateShotStatus] = useState("");
  const rateFileInputRef = useRef(null);

  const applyRate = async (v, source) => {
    const now = new Date().toISOString();
    setRate(v);
    setRateUpdatedAt(now);
    setRateFetchFailed(false);
    try {
      await storage.set(RATE_STORAGE_KEY, JSON.stringify({ rate: v, updatedAt: now, source }), false);
    } catch (e) {
      console.error("rate save failed", e);
    }
  };

  const applyHistRate = (iso, v) => {
    setHistRates((prev) => {
      const next = { ...prev, [iso]: v };
      storage.set(HIST_RATE_STORAGE_KEY, JSON.stringify(next), false).catch((e) => console.error("hist rate save failed", e));
      return next;
    });
  };

  // ---------- bulk rate table paste ----------

  const [showRateTableBox, setShowRateTableBox] = useState(false);
  const [rateTableText, setRateTableText] = useState("");
  const [rateTableStatus, setRateTableStatus] = useState("");
  const [rateTableError, setRateTableError] = useState("");

  const loadRateTable = () => {
    setRateTableError("");
    setRateTableStatus("");
    const { rates, count } = parseRateTableText(rateTableText);
    if (count === 0) {
      setRateTableError("日付とレートのペアを読み取れませんでした。investing.comの表をそのままコピー＆ペーストしてみてください。");
      return;
    }
    setHistRates((prev) => {
      const next = { ...prev, ...rates };
      storage.set(HIST_RATE_STORAGE_KEY, JSON.stringify(next), false).catch((e) => console.error("hist rate save failed", e));
      return next;
    });
    setRateTableStatus(`${count}日分のレートを反映しました。`);
    setRateTableText("");
  };

  const handleRateScreenshot = async (file) => {
    if (!file) return;
    setRateShotLoading(true);
    setRateShotError("");
    setRateShotStatus("");

    // ① まず無料のローカルOCR(Tesseract.js)+正規表現で読み取りを試す。
    //    レートがはっきり写っている一般的なスクショならこれだけで完結する。
    try {
      setRateShotStatus("OCRで読み取り中…");
      const ocrText = await ocrImage(file);
      const { rate: ocrRate, date: ocrDate } = parseRateFromText(ocrText);
      if (ocrRate) {
        const iso = ocrDate ? parseTradeDateISO(ocrDate) : null;
        if (iso) {
          applyHistRate(iso, ocrRate);
          setRateShotStatus(`(無料OCR) ${iso} 時点のレート（$1 = ¥${ocrRate}）として反映しました。`);
        } else {
          await applyRate(ocrRate, "screenshot-ocr");
          setRateShotStatus(`(無料OCR) 現在のレートとして反映しました（$1 = ¥${ocrRate}）。`);
        }
        setTimeout(() => setRateShotStatus(""), 6000);
        setRateShotLoading(false);
        return;
      }
    } catch (e) {
      console.error("OCR failed, falling back to AI", e);
      // OCR自体が失敗した場合も下のAIフォールバックに進む
    }

    // ② OCRで読み取れなかった場合のみ、Claude APIにフォールバックする(有料)。
    if (!apiKey) {
      setRateShotLoading(false);
      setRateShotError("無料OCRでは読み取れませんでした。AI解析を使うにはAnthropicのAPIキーを設定してください(右上の鍵アイコン)。または手動で入力してください。");
      setShowApiKeyInput(true);
      return;
    }
    setRateShotStatus("無料OCRで読み取れなかったため、AIで解析中…");
    try {
      const base64 = await fileToBase64(file);
      const mediaType = file.type || "image/png";
      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: anthropicHeaders(),
        body: JSON.stringify({
          model: "claude-sonnet-4-6",
          max_tokens: 200,
          system:
            'この画像はドル円(USD/JPY)の為替レートを示すスクリーンショットです。「1ドル=何円」を表す数値を読み取ってください。また、画像内にそのレートが「いつ時点」のものかを示す日付(チャートの日付ラベル、「〇月〇日時点」といった表記、検索結果の日付など)があれば、それも読み取ってください。今日時点のレート(現在のレート)であれば日付はnullで構いません。必ず次のJSON形式のみで回答してください。前置きや説明、コードフェンスは一切不要です。{"rate": 152.34, "date": "2026-06-08"} 日付が読み取れない/現在のレートの場合は {"rate": 152.34, "date": null}。レート自体が読み取れない場合は {"rate": null, "date": null}。',
          messages: [
            {
              role: "user",
              content: [
                { type: "image", source: { type: "base64", media_type: mediaType, data: base64 } },
                { type: "text", text: "この画像からドル円レートと、そのレートの日付をJSONで返してください。" },
              ],
            },
          ],
        }),
      });
      if (!response.ok) throw new Error(`API error ${response.status}`);
      const data = await response.json();
      const text = (data.content || [])
        .map((b) => (b.type === "text" ? b.text : ""))
        .join("\n")
        .trim();
      const clean = text.replace(/```json|```/g, "").trim();
      const parsed = JSON.parse(clean);
      const v = typeof parsed.rate === "number" ? parsed.rate : null;
      const rawDate = typeof parsed.date === "string" ? parsed.date : null;
      const iso = rawDate ? parseTradeDateISO(rawDate) : null;

      if (!v || v <= 0) {
        setRateShotError("画像からレートを読み取れませんでした。数値がはっきり写ったスクショで試してください。");
      } else if (iso) {
        applyHistRate(iso, v);
        setRateShotStatus(`(AI解析) ${iso} 時点のレート（$1 = ¥${v}）として、その日の取引に反映しました。`);
        setTimeout(() => setRateShotStatus(""), 6000);
      } else {
        await applyRate(v, "screenshot");
        setRateShotStatus(`(AI解析) 現在のレートとして反映しました（$1 = ¥${v}）。`);
        setTimeout(() => setRateShotStatus(""), 6000);
      }
    } catch (e) {
      console.error(e);
      setRateShotError("読み取りに失敗しました。もう一度お試しいただくか、手動で入力してください。");
    } finally {
      setRateShotLoading(false);
    }
  };

  // load cached historical rates
  useEffect(() => {
    (async () => {
      try {
        const res = await storage.get(HIST_RATE_STORAGE_KEY, false);
        if (res && res.value) {
          const parsed = JSON.parse(res.value);
          if (parsed && typeof parsed === "object") setHistRates(parsed);
        }
      } catch (e) {
        // no cache yet
      }
    })();
  }, []);

  const [histFetchBlocked, setHistFetchBlocked] = useState(false);
  const [histFailStreak, setHistFailStreak] = useState(0);

  const fetchHistRate = async (iso) => {
    // 新ドメイン(api.frankfurter.dev)を優先し、失敗したら旧ドメイン
    // (api.frankfurter.app)にもフォールバックする(どちらか一方が環境によって
    // 不安定/到達不能なケースへの保険)。
    const urls = [
      `https://api.frankfurter.dev/v1/${iso}?base=USD&symbols=JPY`,
      `https://api.frankfurter.app/${iso}?from=USD&to=JPY`,
    ];
    for (const url of urls) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 8000);
        const res = await fetch(url, { signal: controller.signal });
        clearTimeout(timeout);
        if (!res.ok) {
          console.error("historical rate fetch: non-OK response", res.status, url);
          continue;
        }
        const data = await res.json();
        const r = data && data.rates && data.rates.JPY;
        if (typeof r === "number") return r;
      } catch (e) {
        console.error("historical rate fetch failed", url, e);
      }
    }
    return null;
  };

  // when viewing "当時のレート", fetch any dates we don't have yet (and that
  // aren't already covered by a nearby date's rate)
  useEffect(() => {
    if (currencyMode !== "jpy_hist") return;
    const isoDates = Array.from(new Set(trades.map((t) => parseTradeDateISO(t.date)).filter(Boolean)));
    const missing = isoDates.filter((iso) => !(iso in histRates) && !findNearestRate(iso));
    if (missing.length === 0) return;

    // 「APIが完全に到達不能」と確定した場合のみ、以降のリクエストを止めて
    // 残り全部を取得失敗扱いにする(タイムアウト連発を防ぐため)。
    // 1件だけの失敗(その日はまだレート未確定、一時的なタイムアウト等)で
    // 全滅させないよう、3回連続失敗した場合のみブロックする。
    if (histFetchBlocked) {
      setHistRates((prev) => {
        const next = { ...prev };
        missing.forEach((iso) => {
          next[iso] = null;
        });
        storage.set(HIST_RATE_STORAGE_KEY, JSON.stringify(next), false).catch((e) => console.error("hist rate save failed", e));
        return next;
      });
      return;
    }

    let cancelled = false;
    (async () => {
      const r = await fetchHistRate(missing[0]);
      if (cancelled) return;
      if (r === null) {
        setHistFailStreak((prev) => {
          const next = prev + 1;
          if (next >= 3) setHistFetchBlocked(true);
          return next;
        });
      } else {
        setHistFailStreak(0);
      }
      setHistRates((prev) => {
        const next = { ...prev, [missing[0]]: r };
        storage.set(HIST_RATE_STORAGE_KEY, JSON.stringify(next), false).catch((e) => console.error("hist rate save failed", e));
        return next;
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [currencyMode, trades, histRates, histFetchBlocked]);

  const retryFailedHistRates = () => {
    setHistFetchBlocked(false);
    setHistFailStreak(0);
    setHistRates((prev) => {
      const next = {};
      Object.entries(prev).forEach(([k, v]) => {
        if (v !== null) next[k] = v; // 取得失敗(null)だったものだけ消して再取得させる
      });
      storage.set(HIST_RATE_STORAGE_KEY, JSON.stringify(next), false).catch((e) => console.error("hist rate save failed", e));
      return next;
    });
  };

  const persist = useCallback(async (next) => {
    try {
      await storage.set(STORAGE_KEY, JSON.stringify(next), false);
    } catc
