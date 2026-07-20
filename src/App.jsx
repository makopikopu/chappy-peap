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
const FUNDING_STORAGE_KEY = "perp-tracker:funding";

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

  const [fundingEvents, setFundingEvents] = useState([]); // {id, date, ts, coin, usdc}
  const [fundingLoading, setFundingLoading] = useState(false);
  const [fundingStatus, setFundingStatus] = useState("");

  // load persisted funding events
  useEffect(() => {
    (async () => {
      try {
        const res = await storage.get(FUNDING_STORAGE_KEY, false);
        if (res && res.value) {
          const parsed = JSON.parse(res.value);
          if (Array.isArray(parsed)) setFundingEvents(parsed);
        }
      } catch (e) {
        // no data yet, ignore
      }
    })();
  }, []);

  const persistFunding = async (next) => {
    try {
      await storage.set(FUNDING_STORAGE_KEY, JSON.stringify(next), false);
    } catch (e) {
      console.error(e);
    }
  };

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
    if (!apiKey) {
      setRateShotError("先にAnthropicのAPIキーを設定してください(右上の鍵アイコン)。");
      setShowApiKeyInput(true);
      return;
    }
    setRateShotLoading(true);
    setRateShotError("");
    setRateShotStatus("");
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
        setRateShotStatus(`${iso} 時点のレート（$1 = ¥${v}）として、その日の取引に反映しました。`);
        setTimeout(() => setRateShotStatus(""), 6000);
      } else {
        await applyRate(v, "screenshot");
        setRateShotStatus(`現在のレートとして反映しました（$1 = ¥${v}）。`);
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

  const fetchHistRate = async (iso) => {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 6000);
      const res = await fetch(`https://api.frankfurter.app/${iso}?from=USD&to=JPY`, { signal: controller.signal });
      clearTimeout(timeout);
      const data = await res.json();
      const r = data && data.rates && data.rates.JPY;
      return typeof r === "number" ? r : null;
    } catch (e) {
      console.error("historical rate fetch failed", e);
      return null;
    }
  };

  // when viewing "当時のレート", fetch any dates we don't have yet (and that
  // aren't already covered by a nearby date's rate)
  useEffect(() => {
    if (currencyMode !== "jpy_hist") return;
    const isoDates = Array.from(
      new Set(
        trades
          .map((t) => parseTradeDateISO(t.date))
          .concat(fundingEvents.map((f) => parseTradeDateISO(f.date)))
          .filter(Boolean)
      )
    );
    const missing = isoDates.filter((iso) => !(iso in histRates) && !findNearestRate(iso));
    if (missing.length === 0) return;

    // once we've confirmed the API is unreachable from here, don't keep retrying
    // one-by-one (each with its own timeout) — just mark the rest as unavailable.
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
        setHistFetchBlocked(true);
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
  }, [currencyMode, trades, fundingEvents, histRates, histFetchBlocked]);

  const persist = useCallback(async (next) => {
    try {
      await storage.set(STORAGE_KEY, JSON.stringify(next), false);
    } catch (e) {
      console.error("storage save failed", e);
    }
  }, []);

  const updateTrades = useCallback(
    (updater) => {
      setTrades((prev) => {
        const next = typeof updater === "function" ? updater(prev) : updater;
        persist(next);
        return next;
      });
    },
    [persist]
  );

  // ---------- wallet import (Hyperliquid, which powers MetaMask Perps) ----------

  const [walletAddress, setWalletAddress] = useState("");
  const [walletLoading, setWalletLoading] = useState(false);
  const [walletError, setWalletError] = useState("");
  const [walletStatus, setWalletStatus] = useState("");
  const [showPasteFallback, setShowPasteFallback] = useState(true); // this sandbox reliably blocks direct fetch to third-party APIs, so lead with the paste path
  const [pasteJson, setPasteJson] = useState("");

  const dirToSide = (dir) => (dir && dir.toLowerCase().includes("short") ? "short" : "long");

  // PowerShell's ConvertTo-Json sometimes wraps a plain array in an object
  // (e.g. {"value": [...], "Count": 135}) instead of returning it as-is.
  // Dig out the actual fills array wherever it ended up.
  const extractFillsArray = (data) => {
    if (Array.isArray(data)) return data;
    if (data && typeof data === "object") {
      for (const key of Object.keys(data)) {
        if (Array.isArray(data[key])) return data[key];
      }
    }
    return null;
  };

  const processFills = (fills) => {
    const arr = extractFillsArray(fills);
    if (!arr) throw new Error("フィル配列ではないデータが返されました");

    const mapped = arr.map((f) => {
      const isClose = (f.dir || "").toLowerCase().startsWith("close") || (f.dir || "").toLowerCase().includes("liquidat");
      const isOpen = (f.dir || "").toLowerCase().startsWith("open");
      const px = f.px !== undefined ? Number(f.px) : null;
      const ts = typeof f.time === "number" ? f.time : null;
      return {
        id: `hl-${f.tid}`,
        exchange: "Hyperliquid",
        symbol: f.coin || "",
        side: dirToSide(f.dir),
        entryPrice: isOpen ? px : null,
        exitPrice: isClose ? px : null,
        size: f.sz !== undefined ? Number(f.sz) : null,
        leverage: null,
        pnl: f.closedPnl !== undefined ? Number(f.closedPnl) : null,
        fee: f.fee !== undefined ? -Math.abs(Number(f.fee)) : null,
        date: ts ? formatTsInTz(ts, tzMode) : "",
        ts, // exact ms timestamp (true UTC), when we have one
        status: isClose ? "closed" : "open",
        rawDir: f.dir || "",
      };
    });

    let addedCount = 0;
    let replacedCount = 0;
    let backfilledCount = 0;
    updateTrades((prev) => {
      const mappedById = new Map(mapped.map((t) => [t.id, t]));
      const fresh = mapped.filter((t) => !prev.some((p) => p.id === t.id));

      // reconcile against non-wallet entries (manual / screenshot-read trades):
      // a closed trade with matching date, symbol, side, and ~equal pnl is almost
      // certainly the same real-world trade, just read from a screenshot before —
      // replace it with the precise on-chain figures instead of keeping both.
      const toRemoveIds = new Set();
      fresh.forEach((nt) => {
        if (nt.status !== "closed" || typeof nt.pnl !== "number" || nt.pnl === 0) return;
        const match = prev.find(
          (ot) =>
            !ot.id.startsWith("hl-") &&
            !toRemoveIds.has(ot.id) &&
            ot.symbol &&
            nt.symbol &&
            ot.symbol.toUpperCase() === nt.symbol.toUpperCase() &&
            ot.side === nt.side &&
            typeof ot.pnl === "number" &&
            Math.abs(ot.pnl - nt.pnl) < 0.05 &&
            parseTradeDateISO(ot.date) === parseTradeDateISO(nt.date)
        );
        if (match) {
          toRemoveIds.add(match.id);
          replacedCount++;
        }
      });

      // for trades we already had, backfill anything the earlier import was
      // missing (e.g. the exact timestamp, added to this app after they were
      // first loaded) without disturbing anything the user may have edited
      const merged = prev
        .filter((t) => !toRemoveIds.has(t.id))
        .map((t) => {
          const fresh2 = mappedById.get(t.id);
          if (!fresh2) return t;
          if (typeof t.ts !== "number" && typeof fresh2.ts === "number") {
            backfilledCount++;
            return { ...t, ts: fresh2.ts, date: fresh2.date };
          }
          return t;
        });

      addedCount = fresh.length;
      return [...fresh, ...merged];
    });

    const parts = [];
    if (addedCount > 0) parts.push(`${addedCount}件の取引を取得しました`);
    if (replacedCount > 0) parts.push(`うち${replacedCount}件はスクショ由来のデータを正確なオンチェーンデータに置き換えました`);
    if (backfilledCount > 0) parts.push(`${backfilledCount}件は時刻情報を補完しました`);
    setWalletStatus(
      parts.length > 0
        ? `${parts.join("。")}（合計${arr.length}件のフィルを確認）`
        : arr.length > 0
        ? "新しい取引はありませんでした（すでに取得済みです）"
        : "このアドレスの取引履歴が見つかりませんでした"
    );
  };

  const fetchWalletHistory = async () => {
    const addr = walletAddress.trim();
    if (!/^0x[a-fA-F0-9]{40}$/.test(addr)) {
      setWalletError("ウォレットアドレスの形式が正しくありません（0xで始まる42文字）。");
      return;
    }
    setWalletLoading(true);
    setWalletError("");
    try {
      // Hyperliquid's userFillsByTime caps each response at ~500 fills, so a very
      // active account needs multiple requests, each starting where the last left off.
      let allFills = [];
      let startTime = 0;
      const maxPages = 40; // safety cap (40 * 500 = up to 20,000 fills)
      for (let page = 0; page < maxPages; page++) {
        setWalletStatus(`Hyperliquidから取得中…（${allFills.length}件取得済み）`);
        const res = await fetch("https://api.hyperliquid.xyz/info", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "userFillsByTime", user: addr, startTime, aggregateByTime: false }),
        });
        if (!res.ok) {
          const bodyText = await res.text().catch(() => "");
          throw new Error(`API error ${res.status}${bodyText ? `: ${bodyText.slice(0, 200)}` : ""}`);
        }
        const batch = await res.json();
        if (!Array.isArray(batch) || batch.length === 0) break;
        allFills = allFills.concat(batch);
        if (batch.length < 500) break; // fewer than the page size means we've reached the end
        const lastTime = Math.max(...batch.map((f) => (typeof f.time === "number" ? f.time : 0)));
        if (!lastTime || lastTime <= startTime) break; // safety: avoid an infinite loop if time didn't advance
        startTime = lastTime + 1;
      }
      processFills(allFills);
    } catch (e) {
      console.error(e);
      const reason = e && e.message ? e.message : "unknown error";
      setWalletError(
        `取得に失敗しました（${reason}）。この画面から直接アクセスできない場合は、下の「JSONを直接貼り付ける」もお試しください。`
      );
      setShowPasteFallback(true);
    } finally {
      setWalletLoading(false);
      setTimeout(() => setWalletStatus(""), 8000);
    }
  };

  const fetchFunding = async () => {
    const addr = walletAddress.trim();
    if (!/^0x[a-fA-F0-9]{40}$/.test(addr)) {
      setWalletError("ウォレットアドレスの形式が正しくありません（0xで始まる42文字）。");
      return;
    }
    setFundingLoading(true);
    try {
      let all = [];
      let startTime = 0;
      const endTime = Date.now();
      const maxPages = 40;
      for (let page = 0; page < maxPages; page++) {
        setFundingStatus(`Fundingを取得中…（${all.length}件取得済み）`);
        const res = await fetch("https://api.hyperliquid.xyz/info", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "userFunding", user: addr, startTime, endTime }),
        });
        if (!res.ok) {
          const bodyText = await res.text().catch(() => "");
          throw new Error(`API error ${res.status}${bodyText ? `: ${bodyText.slice(0, 200)}` : ""}`);
        }
        const batch = await res.json();
        if (!Array.isArray(batch) || batch.length === 0) break;
        all = all.concat(batch);
        if (batch.length < 500) break;
        const lastTime = Math.max(...batch.map((f) => (typeof f.time === "number" ? f.time : 0)));
        if (!lastTime || lastTime <= startTime) break;
        startTime = lastTime + 1;
      }
      const mapped = all
        .filter((f) => f.delta && f.delta.type === "funding")
        .map((f) => ({
          id: `hlf-${f.hash}-${f.time}-${f.delta.coin}`,
          date: formatTsInTz(f.time, tzMode),
          ts: f.time,
          coin: f.delta.coin,
          usdc: Number(f.delta.usdc),
        }));
      setFundingEvents((prev) => {
        const existingIds = new Set(prev.map((e) => e.id));
        const fresh = mapped.filter((e) => !existingIds.has(e.id));
        const next = [...fresh, ...prev];
        persistFunding(next);
        setFundingStatus(
          fresh.length > 0 ? `${fresh.length}件のFundingを取得しました（合計${mapped.length}件を確認）` : "新しいFundingはありませんでした（すでに取得済みです）"
        );
        return next;
      });
    } catch (e) {
      console.error(e);
      const reason = e && e.message ? e.message : "unknown error";
      setWalletError(`Fundingの取得に失敗しました（${reason}）。`);
    } finally {
      setFundingLoading(false);
      setTimeout(() => setFundingStatus(""), 8000);
    }
  };

  const loadPastedJson = () => {
    setWalletError("");
    let parsed;
    try {
      parsed = JSON.parse(pasteJson);
    } catch (e) {
      console.error(e);
      setWalletError(
        "貼り付けたテキストをJSONとして読み込めませんでした。文字が途中で欠けている可能性があります(手動選択より、Set-Clipboardでコピーする方法が確実です)。"
      );
      return;
    }
    try {
      processFills(parsed);
      setPasteJson("");
    } catch (e) {
      console.error(e);
      setWalletError(`データの形式を認識できませんでした（${e.message || "unknown error"}）。`);
    }
  };

  // ---------- screenshot ingestion ----------

  const handleFiles = async (fileList) => {
    const files = Array.from(fileList || []);
    if (files.length === 0) return;
    if (!apiKey) {
      setUploadError("先にAnthropicのAPIキーを設定してください(右上の鍵アイコン)。");
      setShowApiKeyInput(true);
      return;
    }
    setUploading(true);
    setUploadError("");
    let addedTotal = 0;

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      setUploadStatus(`解析中 (${i + 1}/${files.length})…`);
      try {
        const base64 = await fileToBase64(file);
        const mediaType = file.type || "image/png";

        const systemPrompt = `あなたは暗号資産(仮想通貨)の無期限先物(パーペチュア)取引所のスクリーンショットを読み取るアシスタントです。
画像に写っている取引・ポジションの情報を可能な限り正確に抽出してください。
複数の取引/ポジションが写っている場合は全て抽出してください。

必ず以下のJSON形式のみで回答してください。前置き、説明、コードフェンス(\`\`\`)は一切不要です。

{"trades":[{"exchange":"取引所名の推測 or null","symbol":"例: BTCUSDT","side":"long または short","entryPrice":数値 or null,"exitPrice":数値 or null,"size":数値(枚数/数量) or null,"leverage":数値 or null,"pnl":数値(損益、USD建て、マイナスは損失) or null,"fee":数値 or null,"date":"画像に表示されている日付の文字列" or null,"time":"画像に表示されている時刻の文字列(例: 14:32、2:32 PM)。時刻の表示が無ければnull" or null,"status":"open または closed"}]}

数値はカンマや通貨記号を除いた数値のみにしてください。読み取れない項目はnullにしてください。画像に取引情報が全く無い場合は {"trades":[]} を返してください。`;

        const response = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: anthropicHeaders(),
          body: JSON.stringify({
            model: "claude-sonnet-4-6",
            max_tokens: 1000,
            system: systemPrompt,
            messages: [
              {
                role: "user",
                content: [
                  {
                    type: "image",
                    source: { type: "base64", media_type: mediaType, data: base64 },
                  },
                  {
                    type: "text",
                    text: "この画像から取引データをJSONで抽出してください。",
                  },
                ],
              },
            ],
          }),
        });

        if (!response.ok) {
          const bodyText = await response.text().catch(() => "");
          throw new Error(`API error ${response.status}${bodyText ? `: ${bodyText.slice(0, 200)}` : ""}`);
        }
        const data = await response.json();
        const text = (data.content || [])
          .map((b) => (b.type === "text" ? b.text : ""))
          .join("\n")
          .trim();
        const clean = text.replace(/```json|```/g, "").trim();
        const parsed = JSON.parse(clean);
        const newTrades = (parsed.trades || []).map((t) => {
          const rawDate = t.date || "";
          const iso = parseTradeDateISO(rawDate);
          const ts = buildTimestamp(iso, t.time);
          const displayDate = iso && t.time && ts ? `${iso} ${t.time}` : rawDate;
          return {
            id: uid(),
            exchange: t.exchange || "",
            symbol: t.symbol || "",
            side: t.side === "short" ? "short" : "long",
            entryPrice: typeof t.entryPrice === "number" ? t.entryPrice : null,
            exitPrice: typeof t.exitPrice === "number" ? t.exitPrice : null,
            size: typeof t.size === "number" ? t.size : null,
            leverage: typeof t.leverage === "number" ? t.leverage : null,
            pnl: typeof t.pnl === "number" ? t.pnl : null,
            fee: typeof t.fee === "number" ? t.fee : null,
            date: displayDate,
            ts,
            status: t.status === "open" ? "open" : "closed",
          };
        });

        if (newTrades.length > 0) {
          addedTotal += newTrades.length;
          updateTrades((prev) => [...newTrades, ...prev]);
        }
      } catch (e) {
        console.error(e);
        const reason = e && e.message ? e.message : "unknown error";
        setUploadError(`「${file.name}」の読み取りに失敗しました（${reason}）。手動で追加してください。`);
      }
    }

    setUploading(false);
    setUploadStatus(addedTotal > 0 ? `${addedTotal}件の取引を追加しました` : "");
    setTimeout(() => setUploadStatus(""), 4000);
  };

  // ---------- editing ----------

  const startEdit = (trade) => {
    setEditingId(trade.id);
    setDraft({ ...trade });
  };

  const startAdd = () => {
    const t = EMPTY_TRADE();
    updateTrades((prev) => [t, ...prev]);
    startEdit(t);
  };

  const cancelEdit = () => {
    setEditingId(null);
    setDraft(null);
  };

  const saveEdit = () => {
    updateTrades((prev) => prev.map((t) => (t.id === draft.id ? draft : t)));
    setEditingId(null);
    setDraft(null);
  };

  const deleteTrade = (id) => {
    updateTrades((prev) => prev.filter((t) => t.id !== id));
    if (editingId === id) cancelEdit();
  };

  // ---------- filtering ----------

  const [sourceFilter, setSourceFilter] = useState("all"); // all | wallet | manual

  // ---------- unify date formatting ----------

  const [normalizeStatus, setNormalizeStatus] = useState("");

  const normalizeAllDates = () => {
    let changed = 0;
    let unresolved = 0;
    updateTrades((prev) =>
      prev.map((t) => {
        // trades with a verified-UTC timestamp (currently: wallet-fetched "hl-" trades)
        // get the full date+time in whichever timezone is selected
        if (t.id.startsWith("hl-") && typeof t.ts === "number") {
          const newDate = formatTsInTz(t.ts, tzMode);
          if (newDate !== t.date) {
            changed++;
            return { ...t, date: newDate };
          }
          return t;
        }
        // everything else (manual entries, screenshots) only gets the date part
        // normalized — we don't know for certain what timezone their time, if any, is in
        const iso = parseTradeDateISO(t.date);
        if (iso && iso !== t.date) {
          changed++;
          return { ...t, date: iso };
        }
        if (!iso) unresolved++;
        return t;
      })
    );
    setNormalizeStatus(
      changed > 0
        ? `${changed}件の日付表記を統一しました（ウォレット取得分は${tzMode === "jst" ? "日本時間" : "UTC"}の時刻付き、それ以外はYYYY-MM-DD形式）${unresolved > 0 ? `。${unresolved}件は日付を認識できず変更していません` : ""}`
        : unresolved > 0
        ? `変更対象はありませんでした（${unresolved}件は日付を認識できませんでした）`
        : "すべての日付はすでに統一された形式です"
    );
    setTimeout(() => setNormalizeStatus(""), 8000);
  };

  // ---------- merge duplicate trades ----------

  const [dedupeStatus, setDedupeStatus] = useState("");

  const pickBestTrade = (candidates) => {
    const score = (t) => {
      let s = 0;
      if (t.id.startsWith("hl-")) s += 100; // prefer precise on-chain data
      ["entryPrice", "exitPrice", "size", "leverage", "fee", "pnl"].forEach((k) => {
        if (typeof t[k] === "number") s += 1;
      });
      if (t.exchange) s += 1;
      return s;
    };
    return candidates.reduce((best, cur) => (score(cur) > score(best) ? cur : best));
  };

  const mergeDuplicates = () => {
    const buckets = new Map();
    trades.forEach((t) => {
      const iso = parseTradeDateISO(t.date);
      if (!iso || !t.symbol) return; // can't confidently group without a date+symbol
      const key = `${iso}|${t.symbol.toUpperCase()}|${t.side}`;
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(t);
    });

    const removeIds = new Set();
    let groupCount = 0;

    buckets.forEach((list) => {
      if (list.length < 2) return;

      // decided/closed trades: cluster by pnl closeness
      const closed = list.filter((t) => typeof t.pnl === "number" && t.pnl !== 0);
      const clustersA = [];
      [...closed].sort((a, b) => a.pnl - b.pnl).forEach((t) => {
        const cur = clustersA[clustersA.length - 1];
        const lastT = cur && cur[cur.length - 1];
        const tol = lastT ? Math.max(0.05, Math.abs(lastT.pnl) * 0.01) : 0;
        if (lastT && Math.abs(t.pnl - lastT.pnl) <= tol) cur.push(t);
        else clustersA.push([t]);
      });

      // open / zero-pnl trades: cluster by entry price + size closeness
      const rest = list.filter((t) => !(typeof t.pnl === "number" && t.pnl !== 0));
      const clustersB = [];
      [...rest]
        .sort((a, b) => (a.entryPrice || 0) - (b.entryPrice || 0))
        .forEach((t) => {
          const cur = clustersB[clustersB.length - 1];
          const lastT = cur && cur[cur.length - 1];
          const priceClose =
            lastT &&
            ((typeof t.entryPrice === "number" && typeof lastT.entryPrice === "number" && Math.abs(t.entryPrice - lastT.entryPrice) <= Math.max(0.01, Math.abs(lastT.entryPrice) * 0.005)) ||
              (t.entryPrice == null && lastT.entryPrice == null));
          const sizeClose =
            lastT &&
            ((typeof t.size === "number" && typeof lastT.size === "number" && Math.abs(t.size - lastT.size) <= Math.max(0.00001, Math.abs(lastT.size) * 0.02)) ||
              (t.size == null && lastT.size == null));
          if (lastT && priceClose && sizeClose) cur.push(t);
          else clustersB.push([t]);
        });

      [...clustersA, ...clustersB].forEach((cluster) => {
        if (cluster.length < 2) return;
        groupCount++;
        const best = pickBestTrade(cluster);
        cluster.forEach((t) => {
          if (t.id !== best.id) removeIds.add(t.id);
        });
      });
    });

    if (removeIds.size === 0) {
      setDedupeStatus("重複している取引は見つかりませんでした。");
    } else {
      updateTrades((prev) => prev.filter((t) => !removeIds.has(t.id)));
      setDedupeStatus(`${groupCount}組・合計${removeIds.size}件の重複を統合しました（各組で最も情報量の多い1件を残しました）。`);
    }
    setTimeout(() => setDedupeStatus(""), 8000);
  };

  // ---------- derived stats ----------

  const [sortOrder, setSortOrder] = useState("desc"); // desc = newest first, asc = oldest first
  const [periodMode, setPeriodMode] = useState("month"); // year | month | week
  const [expandedPeriods, setExpandedPeriods] = useState(new Set());

  const togglePeriod = (key) => {
    setExpandedPeriods((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const filteredTrades = trades
    .filter((t) => {
      if (sourceFilter === "wallet") return t.id.startsWith("hl-");
      if (sourceFilter === "manual") return !t.id.startsWith("hl-");
      return true;
    })
    .slice()
    .sort((a, b) => {
      const isoA = parseTradeDateISO(a.date);
      const isoB = parseTradeDateISO(b.date);
      if (!isoA && !isoB) return 0;
      if (!isoA) return 1; // unrecognized dates sink to the bottom
      if (!isoB) return -1;
      if (isoA !== isoB) return sortOrder === "desc" ? (isoA < isoB ? 1 : -1) : isoA < isoB ? -1 : 1;
      // same day: use the exact timestamp when both sides have one (e.g. wallet-fetched
      // trades), otherwise leave same-day entries in their existing order
      if (typeof a.ts === "number" && typeof b.ts === "number" && a.ts !== b.ts) {
        return sortOrder === "desc" ? b.ts - a.ts : a.ts - b.ts;
      }
      return 0;
    });

  const withPnl = trades.filter((t) => typeof t.pnl === "number");
  const totalPnl = withPnl.reduce((s, t) => s + t.pnl, 0);
  const wins = withPnl.filter((t) => t.pnl > 0).length;
  const losses = withPnl.filter((t) => t.pnl < 0).length;
  const decidedCount = wins + losses;
  const winRate = decidedCount > 0 ? (wins / decidedCount) * 100 : null;
  const totalFees = trades.reduce((s, t) => s + (typeof t.fee === "number" ? t.fee : 0), 0);
  const totalFundingUsd = fundingEvents.reduce((s, f) => s + (typeof f.usdc === "number" ? f.usdc : 0), 0);
  const netPnlUsd = totalPnl + totalFees + totalFundingUsd;
  const avgLeverage =
    trades.filter((t) => typeof t.leverage === "number").length > 0
      ? trades.filter((t) => typeof t.leverage === "number").reduce((s, t) => s + t.leverage, 0) /
        trades.filter((t) => typeof t.leverage === "number").length
      : null;

  // ---------- currency conversion helpers ----------

  const isoOf = (t) => parseTradeDateISO(t.date);

  // finds the closest date on/before `iso` that has a known numeric rate
  // (weekends/holidays aren't in FX tables, so we fall back to the last trading day)
  const findNearestRate = (iso) => {
    if (typeof histRates[iso] === "number") return { rate: histRates[iso], sourceIso: iso, exact: true };
    let bestIso = null;
    for (const key of Object.keys(histRates)) {
      if (typeof histRates[key] !== "number") continue;
      if (key <= iso && (!bestIso || key > bestIso)) bestIso = key;
    }
    if (bestIso) return { rate: histRates[bestIso], sourceIso: bestIso, exact: false };
    return null;
  };

  // classifies exactly how a trade's yen value is being computed, for both
  // the numeric conversion and the "適用レート" column display
  const classifyRateForTrade = (t) => {
    if (currencyMode === "jpy_now") return { kind: "now" };
    if (currencyMode !== "jpy_hist") return { kind: "usd" };
    const iso = isoOf(t);
    if (!iso) return { kind: "fallback", reason: "unknown_date" };
    const nearest = findNearestRate(iso);
    if (nearest) return nearest.exact ? { kind: "exact", rate: nearest.rate, iso } : { kind: "nearest", rate: nearest.rate, sourceIso: nearest.sourceIso };
    if (histRates[iso] === undefined) return { kind: "pending" };
    return { kind: "fallback", reason: "fetch_failed" };
  };

  // rate that applies to this trade under the current display mode; undefined = still fetching
  const rateForTrade = (t) => {
    const c = classifyRateForTrade(t);
    if (c.kind === "usd") return null;
    if (c.kind === "now") return rate;
    if (c.kind === "pending") return undefined;
    if (c.kind === "fallback") return rate;
    return c.rate;
  };

  const isRowPending = (t) => classifyRateForTrade(t).kind === "pending";
  const isRowFallback = (t) => classifyRateForTrade(t).kind === "fallback";

  const convertedAmount = (usdVal, t) => {
    if (usdVal === null || usdVal === undefined) return null;
    if (currencyMode === "usd") return usdVal;
    const r = rateForTrade(t);
    return typeof r === "number" ? usdVal * r : null;
  };

  const totalFundingConverted = fundingEvents.reduce((s, f) => s + (convertedAmount(f.usdc, f) || 0), 0);
  const netPnlConverted = trades.reduce((s, t) => s + (convertedAmount(t.pnl, t) || 0) + (convertedAmount(t.fee, t) || 0), totalFundingConverted);

  const fmtJpyRaw = (yen) => {
    if (yen === null || yen === undefined || Number.isNaN(yen)) return "—";
    const sign = yen > 0 ? "+" : "";
    return `${sign}¥${Math.round(yen).toLocaleString("ja-JP")}`;
  };

  // human-readable summary of which rate was applied to a given trade, for the "適用レート" column
  const rateInfoForTrade = (t) => {
    const c = classifyRateForTrade(t);
    if (c.kind === "usd") return null;
    if (c.kind === "now") {
      return { text: rate ? `¥${fmt(rate, 2)}` : "—", badge: "現在レート", badgeColor: COLORS.textDim };
    }
    if (c.kind === "pending") return { text: "取得中…", badge: null, badgeColor: COLORS.textDim };
    if (c.kind === "exact") {
      return { text: `¥${fmt(c.rate, 2)}`, badge: `${c.iso} 時点`, badgeColor: COLORS.profit };
    }
    if (c.kind === "nearest") {
      return { text: `¥${fmt(c.rate, 2)}`, badge: `${c.sourceIso} 時点(直近)`, badgeColor: COLORS.gold };
    }
    // fallback
    return {
      text: rate ? `¥${fmt(rate, 2)}` : "—",
      badge: c.reason === "unknown_date" ? "日付不明" : "当時レート取得失敗",
      badgeColor: COLORS.loss,
    };
  };

  const histPendingCount = currencyMode === "jpy_hist" ? withPnl.filter(isRowPending).length : 0;
  const histFallbackCount = currencyMode === "jpy_hist" ? withPnl.filter((t) => !isRowPending(t) && isRowFallback(t)).length : 0;

  const totalConverted =
    currencyMode === "usd"
      ? totalPnl
      : withPnl.reduce((s, t) => s + (convertedAmount(t.pnl, t) || 0), 0);

  // cumulative pnl chart data, oldest -> newest by array order (reverse since newest prepended)
  const chronological = [...withPnl].reverse();
  let running = 0;
  const chartData = chronological.map((t, idx) => {
    const v = currencyMode === "usd" ? t.pnl : convertedAmount(t.pnl, t) ?? 0;
    running += v;
    return { idx: idx + 1, label: t.date || `#${idx + 1}`, cum: Number(running.toFixed(2)) };
  });

  const isProfit = totalPnl >= 0;

  // ---------- period breakdown (year / month / week) ----------

  const periodKeyFor = (iso) => {
    if (periodMode === "year") return iso.slice(0, 4);
    if (periodMode === "month") return iso.slice(0, 7);
    return isoWeekKey(iso);
  };

  const periodMap = {};
  withPnl.forEach((t) => {
    const iso = isoOf(t);
    if (!iso) return;
    const key = periodKeyFor(iso);
    if (!periodMap[key]) periodMap[key] = { key, count: 0, wins: 0, losses: 0, usdPnl: 0, converted: 0, pending: 0 };
    const g = periodMap[key];
    g.count++;
    g.usdPnl += t.pnl;
    if (t.pnl > 0) g.wins++;
    else if (t.pnl < 0) g.losses++;
    if (currencyMode === "usd") {
      g.converted += t.pnl;
    } else {
      const conv = convertedAmount(t.pnl, t);
      if (typeof conv === "number") g.converted += conv;
      else g.pending++;
    }
  });
  const periodData = Object.values(periodMap).sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  const periodValue = (g) => (currencyMode === "usd" ? g.usdPnl : g.converted);
  const periodLabel = (g) => {
    if (periodMode === "year") return `${g.key}年`;
    if (periodMode === "month") {
      const [y, m] = g.key.split("-");
      return `${y}年${Number(m)}月`;
    }
    return g.key.replace("-W", "年 第") + "週";
  };
  const periodFmt = (v) => (currencyMode === "usd" ? fmtUsd(v) : fmtJpyRaw(v));

  // all trades (opens included) belonging to a given period key, newest first
  const tradesForPeriod = (key) =>
    trades
      .filter((t) => {
        const iso = isoOf(t);
        return iso && periodKeyFor(iso) === key;
      })
      .sort((a, b) => {
        const isoA = isoOf(a);
        const isoB = isoOf(b);
        return isoA < isoB ? 1 : isoA > isoB ? -1 : 0;
      });

  return (
    <div style={styles.page}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600;700&family=Space+Grotesk:wght@400;500;600;700&display=swap');
        * { box-sizing: border-box; }
        body { margin: 0; }
        input, select { font-family: 'JetBrains Mono', monospace; }
        ::selection { background: #D9A44144; }
      `}</style>

      <header style={styles.header}>
        <div>
          <div style={styles.eyebrow}>PERP LEDGER</div>
          <h1 style={styles.title}>パーペチュアル損益トラッカー</h1>
        </div>

        <button
          style={{ ...styles.iconBtn, border: `1px solid ${apiKey ? COLORS.border : COLORS.loss}`, borderRadius: 8, padding: 8 }}
          onClick={() => {
            setApiKeyDraft(apiKey);
            setShowApiKeyInput((s) => !s);
          }}
          title={apiKey ? "AnthropicのAPIキー設定済み" : "AnthropicのAPIキーが未設定です(スクショ読み取りに必要)"}
        >
          <Settings size={16} color={apiKey ? COLORS.textDim : COLORS.loss} />
        </button>

        <div style={styles.rateWidget}>
          {rateEditing ? (
            <>
              <input
                autoFocus
                style={{ ...styles.editInput, width: 90 }}
                value={rateInput}
                onChange={(e) => setRateInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && saveManualRate()}
                placeholder="例: 152.30"
              />
              <button style={styles.iconBtn} onClick={saveManualRate} aria-label="保存"><Check size={14} color={COLORS.profit} /></button>
              <button style={styles.iconBtn} onClick={() => setRateEditing(false)} aria-label="取消"><X size={14} color={COLORS.loss} /></button>
            </>
          ) : (
            <button
              style={{
                ...styles.rateBtn,
                ...(rateFetchFailed && !rate ? { borderColor: COLORS.loss, color: COLORS.loss } : {}),
              }}
              onClick={() => {
                setRateInput(rate ? String(rate) : "");
                setRateEditing(true);
              }}
              title="タップして手動で変更"
            >
              <RefreshCw size={12} className={rateLoading ? "spin" : ""} style={rateLoading ? { animation: "spin 1s linear infinite" } : undefined} />
              {rate
                ? `$1 = ¥${fmt(rate, 2)}`
                : rateLoading
                ? "為替レート取得中…"
                : rateFetchFailed
                ? "自動取得できません・タップして入力"
                : "タップしてレートを入力"}
            </button>
          )}
          {!rateEditing && (
            <label style={{ ...styles.iconBtn, cursor: rateShotLoading ? "default" : "pointer" }} title="為替レートのスクショから読み取る">
              {rateShotLoading ? (
                <Loader2 size={14} style={{ animation: "spin 1s linear infinite" }} />
              ) : (
                <Camera size={14} />
              )}
              <input
                ref={rateFileInputRef}
                type="file"
                accept="image/*"
                style={{ display: "none" }}
                disabled={rateShotLoading}
                onChange={(e) => {
                  const file = e.target.files && e.target.files[0];
                  handleRateScreenshot(file);
                  e.target.value = "";
                }}
              />
            </label>
          )}
        </div>

        <label
          style={{ ...styles.btnPrimary, opacity: uploading ? 0.6 : 1, pointerEvents: uploading ? "none" : "auto" }}
        >
          {uploading ? <Loader2 size={16} className="spin" style={{ animation: "spin 1s linear infinite" }} /> : <Upload size={16} />}
          {uploading ? uploadStatus || "解析中…" : "スクショを読み込む"}
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            style={{ display: "none" }}
            onChange={(e) => {
              handleFiles(e.target.files);
              e.target.value = "";
            }}
          />
        </label>
      </header>

      {showApiKeyInput && (
        <div style={styles.card}>
          <div style={styles.cardTitle}>Anthropic APIキー</div>
          <div style={styles.walletNote}>
            スクショ読み取り機能(取引履歴・為替レート)は、ブラウザから直接Anthropic社のAPIを呼び出します。
            <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noreferrer" style={{ color: COLORS.gold }}>
              console.anthropic.com
            </a>
            でAPIキーを発行して貼り付けてください。このブラウザのlocalStorageにのみ保存され、api.anthropic.com以外には送信されません。利用には課金設定(クレジット)が必要です。
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
            <input
              type="password"
              style={{ ...styles.editInput, flex: 1, minWidth: 240 }}
              value={apiKeyDraft}
              onChange={(e) => setApiKeyDraft(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && saveApiKey()}
              placeholder="sk-ant-api03-..."
            />
            <button style={styles.btnPrimary} onClick={saveApiKey}>
              保存
            </button>
            <button style={styles.btnGhost} onClick={() => setShowApiKeyInput(false)}>
              閉じる
            </button>
          </div>
        </div>
      )}

      {uploadError && (
        <div style={styles.errorBanner}>
          <ImageOff size={14} /> {uploadError}
        </div>
      )}
      {!uploading && uploadStatus && <div style={styles.successBanner}>{uploadStatus}</div>}
      {rateShotError && (
        <div style={styles.errorBanner}>
          <ImageOff size={14} /> {rateShotError}
        </div>
      )}
      {rateShotStatus && <div style={styles.successBanner}>{rateShotStatus}</div>}

      {/* wallet import */}
      <div style={styles.card}>
        <div style={styles.cardTitle}>ウォレットアドレスから取得(Hyperliquid / MetaMask Perps)</div>
        <div style={styles.walletNote}>
          MetaMaskのPerpsは内部でHyperliquid(HyperEVM)を使っているため、ウォレットアドレスから取引履歴を取得できます。ただし<strong>この画面(artifact)からは外部APIへの直接アクセスがブロックされていることが多く</strong>、「取得」ボタンは失敗する可能性が高いです。まずは下のJSON貼り付け欄をお使いください。
        </div>
        <div style={{ ...styles.walletRow, marginTop: 10 }}>
          <input
            style={{ ...styles.editInput, flex: 1, minWidth: 200 }}
            value={walletAddress}
            onChange={(e) => setWalletAddress(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && !walletLoading && fetchWalletHistory()}
            placeholder="0x… で始まるウォレットアドレス"
          />
          <button style={{ ...styles.btnGhost, opacity: walletLoading ? 0.6 : 1 }} disabled={walletLoading} onClick={fetchWalletHistory} title="ダメ元で直接取得を試す">
            {walletLoading ? <Loader2 size={16} style={{ animation: "spin 1s linear infinite" }} /> : <RefreshCw size={16} />}
            {walletLoading ? "取得中…" : "直接取得を試す"}
          </button>
          <button style={{ ...styles.btnGhost, opacity: fundingLoading ? 0.6 : 1 }} disabled={fundingLoading} onClick={fetchFunding} title="同じアドレスでFunding(資金調達料)履歴も取得">
            {fundingLoading ? <Loader2 size={16} style={{ animation: "spin 1s linear infinite" }} /> : <RefreshCw size={16} />}
            {fundingLoading ? "取得中…" : "Fundingも取得"}
          </button>
        </div>
        {fundingStatus && <div style={{ ...styles.successBanner, marginTop: 10, marginBottom: 0 }}>{fundingStatus}</div>}
        {walletError && (
          <div style={{ ...styles.errorBanner, marginTop: 10, marginBottom: 0 }}>
            <ImageOff size={14} /> {walletError}
          </div>
        )}
        {!walletLoading && walletStatus && (
          <div style={{ ...styles.successBanner, marginTop: 10, marginBottom: 0 }}>{walletStatus}</div>
        )}

        <div style={styles.pasteBox}>
          <div style={styles.pasteTitle}>JSONを貼り付けて取り込む(推奨)</div>
          <div style={styles.walletNote}>
            パソコンやスマホのブラウザで下のURLを開くか、curl等で以下のリクエストを送り、返ってきたJSONをそのまま下の欄に貼り付けてください（アドレス部分は自分のものに置き換え）。
            <br />
            <strong>注意:</strong> このAPIは1回のリクエストで最大500件までしか返しません。取引が500件を超える場合は、返ってきたJSONの中で一番大きい<code>time</code>の値に1を足したものを次の<code>startTime</code>にして、続きを取得し直してください（複数回に分けて貼り付け・読み込みを繰り返せば、それぞれ重複なく統合されます）。
          </div>
          <pre style={styles.codeBlock}>
{`curl -s -X POST https://api.hyperliquid.xyz/info \\
  -H "Content-Type: application/json" \\
  -d '{"type":"userFillsByTime","user":"${walletAddress || "0xあなたのアドレス"}","startTime":0}'`}
          </pre>
          <textarea
            style={styles.pasteArea}
            value={pasteJson}
            onChange={(e) => setPasteJson(e.target.value)}
            placeholder='[{"coin":"BTC","dir":"Close Long", ...}]'
            rows={5}
          />
          <button style={styles.btnGhost} onClick={loadPastedJson} disabled={!pasteJson.trim()}>
            このJSONを読み込む
          </button>
        </div>
      </div>

      {/* currency mode toggle */}
      <div style={styles.modeToggle}>
        {[
          ["usd", "USD"],
          ["jpy_now", "円換算(現在レート)"],
          ["jpy_hist", "円換算(取引当時レート)"],
        ].map(([mode, label]) => (
          <button
            key={mode}
            onClick={() => setCurrencyMode(mode)}
            style={{
              ...styles.modeBtn,
              ...(currencyMode === mode ? styles.modeBtnActive : {}),
            }}
          >
            {label}
          </button>
        ))}
      </div>

      {currencyMode !== "usd" && !rate && !rateLoading && (
        <div style={styles.errorBanner}>
          <RefreshCw size={14} />
          為替レートを自動取得できませんでした。円換算を表示するには、右上のレート表示をタップして手動でレートを入力してください(例: 152.30)。
        </div>
      )}

      {currencyMode === "jpy_hist" && (
        <div style={{ marginBottom: 14 }}>
          {!showRateTableBox ? (
            <button style={styles.linkBtn} onClick={() => setShowRateTableBox(true)}>
              投資サイトの為替レート表を貼り付けて一括反映する
            </button>
          ) : (
            <div style={styles.card}>
              <div style={styles.cardTitle}>為替レート表を一括反映</div>
              <div style={styles.walletNote}>
                investing.comなどの「ヒストリカルデータ」の表をそのままコピー＆ペーストしてください（日付＋終値の列があれば認識します）。
              </div>
              <textarea
                style={{ ...styles.pasteArea, marginTop: 8 }}
                value={rateTableText}
                onChange={(e) => setRateTableText(e.target.value)}
                placeholder={"2026年7月10日\t161.70\t162.38\t162.49\t161.27\t\t-0.42%\n2026年7月09日\t162.39\t..."}
                rows={6}
              />
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <button style={styles.btnGhost} onClick={loadRateTable} disabled={!rateTableText.trim()}>
                  読み込む
                </button>
                <button style={styles.btnGhost} onClick={() => setShowRateTableBox(false)}>
                  閉じる
                </button>
              </div>
              {rateTableError && (
                <div style={{ ...styles.errorBanner, marginTop: 10, marginBottom: 0 }}>
                  <ImageOff size={14} /> {rateTableError}
                </div>
              )}
              {rateTableStatus && (
                <div style={{ ...styles.successBanner, marginTop: 10, marginBottom: 0 }}>{rateTableStatus}</div>
              )}
            </div>
          )}
        </div>
      )}

      {/* hero ticker */}
      <div style={styles.hero}>
        <div style={styles.heroLabel}>
          総損益{currencyMode === "jpy_now" ? "（現在レート換算・手数料/Funding抜き）" : currencyMode === "jpy_hist" ? "（取引当時レート換算・手数料/Funding抜き）" : "（手数料/Funding抜き）"}
        </div>
        <div style={{ ...styles.heroNumber, color: isProfit ? COLORS.profit : COLORS.loss }}>
          {isProfit ? <TrendingUp size={32} /> : <TrendingDown size={32} />}
          {currencyMode === "usd" ? fmtUsd(totalPnl) : fmtJpyRaw(totalConverted)}
        </div>
        {currencyMode !== "usd" && (
          <div style={{ ...styles.heroJpy, color: isProfit ? COLORS.profit : COLORS.loss }}>{fmtUsd(totalPnl)}</div>
        )}
        <div style={styles.heroSub}>
          {withPnl.length} 件の損益データ / 全 {trades.length} 件の取引
          {currencyMode === "jpy_now" && rate && ` ・ $1 = ¥${fmt(rate, 2)}`}
          {currencyMode === "jpy_hist" && histPendingCount > 0 && ` ・ ${histPendingCount}件のレート取得中…`}
          {currencyMode === "jpy_hist" &&
            histPendingCount === 0 &&
            histFallbackCount > 0 &&
            ` ・ うち${histFallbackCount}件は日付不明/取得失敗のため現在レートで代用`}
        </div>
        <div style={{ ...styles.heroSub, marginTop: 10, paddingTop: 10, borderTop: `1px solid ${COLORS.border}` }}>
          <span style={{ color: COLORS.textDim }}>純損益(手数料・Funding込みの最終結果)</span>
          <div style={{ fontSize: 20, fontWeight: 700, color: netPnlUsd >= 0 ? COLORS.profit : COLORS.loss, marginTop: 2 }}>
            {currencyMode === "usd" ? fmtUsd(netPnlUsd) : fmtJpyRaw(netPnlConverted)}
          </div>
        </div>
      </div>

      {/* stat cards */}
      <div style={styles.statGrid}>
        <StatCard label="勝率" value={winRate === null ? "—" : `${fmt(winRate, 1)}%`} sub={`${wins}勝 ${losses}敗`} />
        <StatCard label="取引数" value={trades.length} sub="累計" />
        <StatCard label="平均レバレッジ" value={avgLeverage === null ? "—" : `${fmt(avgLeverage, 1)}x`} sub="記録あり分" />
        <StatCard label="支払手数料合計" value={`$${fmt(totalFees)}`} sub="累計" />
        <StatCard
          label="Funding合計"
          value={fundingEvents.length === 0 ? "未取得" : `$${fmt(totalFundingUsd)}`}
          sub={fundingEvents.length === 0 ? "下の「取得」から" : `${fundingEvents.length}件`}
        />
      </div>

      {/* chart */}
      <div style={styles.card}>
        <div style={styles.cardTitle}>累積損益の推移{currencyMode !== "usd" ? "（円換算）" : ""}</div>
        {chartData.length > 1 ? (
          <ResponsiveContainer width="100%" height={220}>
            <LineChart data={chartData} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
              <CartesianGrid stroke={COLORS.border} strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="idx" tick={{ fill: COLORS.textDim, fontSize: 11 }} axisLine={{ stroke: COLORS.border }} tickLine={false} />
              <YAxis
                tick={{ fill: COLORS.textDim, fontSize: 11 }}
                axisLine={{ stroke: COLORS.border }}
                tickLine={false}
                width={70}
                tickFormatter={(v) => (currencyMode === "usd" ? `$${fmt(v, 0)}` : `¥${fmt(v, 0)}`)}
              />
              <ReferenceLine y={0} stroke={COLORS.border} />
              <Tooltip
                contentStyle={{ background: COLORS.surface, border: `1px solid ${COLORS.border}`, borderRadius: 8, fontFamily: "'JetBrains Mono', monospace", fontSize: 12 }}
                labelStyle={{ color: COLORS.textDim }}
                formatter={(v) => [currencyMode === "usd" ? `$${fmt(v)}` : `¥${fmt(v, 0)}`, "累積損益"]}
                labelFormatter={(l) => `取引 #${l}`}
              />
              <Line type="monotone" dataKey="cum" stroke={COLORS.gold} strokeWidth={2} dot={{ r: 3, fill: COLORS.gold }} activeDot={{ r: 5 }} />
            </LineChart>
          </ResponsiveContainer>
        ) : (
          <div style={styles.emptyChart}>損益データが2件以上になるとグラフが表示されます</div>
        )}
      </div>

      {/* period breakdown */}
      <div style={styles.card}>
        <div style={styles.tableHeaderRow}>
          <div style={styles.cardTitle}>期間別損益{currencyMode !== "usd" ? "（円換算）" : ""}</div>
          <div style={styles.modeToggle}>
            {[
              ["year", "年別"],
              ["month", "月別"],
              ["week", "週別"],
            ].map(([m, label]) => (
              <button
                key={m}
                onClick={() => setPeriodMode(m)}
                style={{ ...styles.modeBtn, ...(periodMode === m ? styles.modeBtnActive : {}) }}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {periodData.length === 0 ? (
          <div style={styles.emptyChart}>損益データがまだありません</div>
        ) : (
          <>
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={periodData} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
                <CartesianGrid stroke={COLORS.border} strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="key" tick={{ fill: COLORS.textDim, fontSize: 10 }} axisLine={{ stroke: COLORS.border }} tickLine={false} />
                <YAxis
                  tick={{ fill: COLORS.textDim, fontSize: 11 }}
                  axisLine={{ stroke: COLORS.border }}
                  tickLine={false}
                  width={70}
                  tickFormatter={(v) => (currencyMode === "usd" ? `$${fmt(v, 0)}` : `¥${fmt(v, 0)}`)}
                />
                <ReferenceLine y={0} stroke={COLORS.border} />
                <Tooltip
                  contentStyle={{ background: COLORS.surface, border: `1px solid ${COLORS.border}`, borderRadius: 8, fontFamily: "'JetBrains Mono', monospace", fontSize: 12 }}
                  labelStyle={{ color: COLORS.textDim }}
                  formatter={(v) => [periodFmt(v), "損益"]}
                  labelFormatter={(l, payload) => (payload && payload[0] ? periodLabel(payload[0].payload) : l)}
                />
                <Bar dataKey={(g) => periodValue(g)} radius={[3, 3, 0, 0]}>
                  {periodData.map((g) => (
                    <Cell key={g.key} fill={periodValue(g) >= 0 ? COLORS.profit : COLORS.loss} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>

            <div style={styles.tableWrap}>
              <table style={styles.table}>
                <thead>
                  <tr>
                    <th style={styles.th}></th>
                    <th style={styles.th}>期間</th>
                    <th style={styles.th}>取引数</th>
                    <th style={styles.th}>勝敗</th>
                    <th style={styles.th}>損益</th>
                  </tr>
                </thead>
                <tbody>
                  {[...periodData].reverse().map((g) => {
                    const v = periodValue(g);
                    const isOpen = expandedPeriods.has(g.key);
                    return (
                      <React.Fragment key={g.key}>
                        <tr style={{ ...styles.tr, cursor: "pointer" }} onClick={() => togglePeriod(g.key)}>
                          <td style={{ ...styles.td, width: 20 }}>
                            {isOpen ? <ChevronDown size={14} color={COLORS.textDim} /> : <ChevronRight size={14} color={COLORS.textDim} />}
                          </td>
                          <td style={{ ...styles.td, fontWeight: 600 }}>{periodLabel(g)}</td>
                          <td style={styles.td}>{g.count}件</td>
                          <td style={styles.td}>
                            {g.wins}勝{g.losses}敗
                          </td>
                          <td style={{ ...styles.td, fontWeight: 700, color: v > 0 ? COLORS.profit : v < 0 ? COLORS.loss : COLORS.text }}>
                            {periodFmt(v)}
                            {currencyMode !== "usd" && g.pending > 0 && (
                              <div style={styles.tdSub}>({g.pending}件レート取得中)</div>
                            )}
                          </td>
                        </tr>
                        {isOpen && (
                          <tr>
                            <td colSpan={5} style={{ padding: 0, borderBottom: `1px solid ${COLORS.border}22` }}>
                              <div style={styles.periodDetailWrap}>
                                <table style={{ ...styles.table, fontSize: 11.5 }}>
                                  <thead>
                                    <tr>
                                      {["日時", "銘柄", "方向", "損益", "手数料", "状態"].map((h) => (
                                        <th key={h} style={{ ...styles.th, opacity: 0.7 }}>{h}</th>
                                      ))}
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {tradesForPeriod(g.key).map((t) => (
                                      <tr key={t.id} style={styles.tr}>
                                        <td style={styles.td}>{t.date || "—"}</td>
                                        <td style={{ ...styles.td, fontWeight: 600 }}>{t.symbol || "—"}</td>
                                        <td style={styles.td}>
                                          <span style={{ ...styles.sideBadge, color: t.side === "short" ? COLORS.loss : COLORS.profit, borderColor: t.side === "short" ? COLORS.loss : COLORS.profit }}>
                                            {t.side === "short" ? "SHORT" : "LONG"}
                                          </span>
                                        </td>
                                        <td style={{ ...styles.td, fontWeight: 700, color: t.pnl > 0 ? COLORS.profit : t.pnl < 0 ? COLORS.loss : COLORS.text }}>
                                          {t.pnl === null
                                            ? "—"
                                            : currencyMode === "usd"
                                            ? fmtUsd(t.pnl)
                                            : isRowPending(t)
                                            ? "取得中…"
                                            : fmtJpyRaw(convertedAmount(t.pnl, t))}
                                        </td>
                                        <td style={styles.td}>
                                          {t.fee === null
                                            ? "—"
                                            : currencyMode === "usd"
                                            ? `$${fmt(t.fee)}`
                                            : isRowPending(t)
                                            ? "…"
                                            : fmtJpyRaw(convertedAmount(t.fee, t))}
                                        </td>
                                        <td style={styles.td}>
                                          <span style={{ ...styles.statusBadge, opacity: t.status === "open" ? 1 : 0.5 }}>
                                            {t.status === "open" ? "オープン" : "決済済"}
                                          </span>
                                        </td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              </div>
                            </td>
                          </tr>
                        )}
                      </React.Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>

      {/* table */}
      <div style={styles.card}>
        <div style={styles.tableHeaderRow}>
          <div style={styles.cardTitle}>取引一覧</div>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <button
              style={styles.btnGhost}
              onClick={() => setTzMode((z) => (z === "jst" ? "utc" : "jst"))}
              title="ウォレット取得データの時刻表示を切り替えます"
            >
              <RefreshCw size={14} /> {tzMode === "jst" ? "日本時間(JST)" : "UTC"}
            </button>
            <button style={styles.btnGhost} onClick={mergeDuplicates} title="日付・銘柄・方向・損益（またはエントリー価格）が一致する重複を統合します">
              <Check size={14} /> 重複を統合
            </button>
            <button style={styles.btnGhost} onClick={normalizeAllDates} title="全取引の日付表記を統一します（ウォレット取得分は時刻付き）">
              <RefreshCw size={14} /> 日付表記を統一
            </button>
            <button style={styles.btnGhost} onClick={startAdd}>
              <Plus size={14} /> 手動で追加
            </button>
          </div>
        </div>

        {dedupeStatus && <div style={{ ...styles.successBanner, marginBottom: 10 }}>{dedupeStatus}</div>}
        {normalizeStatus && <div style={{ ...styles.successBanner, marginBottom: 10 }}>{normalizeStatus}</div>}

        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 10, marginBottom: 10 }}>
          <div style={styles.modeToggle}>
            {[
              ["all", "すべて"],
              ["wallet", "ウォレット取得のみ"],
              ["manual", "手動・スクショのみ"],
            ].map(([f, label]) => (
              <button
                key={f}
                onClick={() => setSourceFilter(f)}
                style={{ ...styles.modeBtn, ...(sourceFilter === f ? styles.modeBtnActive : {}) }}
              >
                {label}
              </button>
            ))}
          </div>
          <button
            style={styles.btnGhost}
            onClick={() => setSortOrder((o) => (o === "desc" ? "asc" : "desc"))}
            title="日時で並び替え"
          >
            {sortOrder === "desc" ? "新しい順" : "古い順"}
          </button>
        </div>

        {trades.length === 0 ? (
          <div style={styles.emptyState}>
            まだ取引がありません。上の「スクショを読み込む」から取引履歴の画像を追加するか、手動で追加してください。
          </div>
        ) : filteredTrades.length === 0 ? (
          <div style={styles.emptyState}>この条件に一致する取引はありません。</div>
        ) : (
          <div style={styles.tableWrap}>
            <table style={styles.table}>
              <thead>
                <tr>
                  {[
                    "日時",
                    "取引所",
                    "銘柄",
                    "方向",
                    "エントリー",
                    "決済",
                    "数量",
                    "レバレッジ",
                    ...(currencyMode !== "usd" ? ["適用レート(1ドル)"] : []),
                    currencyMode === "usd" ? "損益" : currencyMode === "jpy_now" ? "損益(円・現在レート)" : "損益(円・当時レート)",
                    currencyMode === "usd" ? "手数料" : "手数料(円)",
                    "状態",
                    "",
                  ].map((h) => (
                    <th key={h} style={styles.th}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filteredTrades.map((t) =>
                  editingId === t.id ? (
                    <EditRow key={t.id} draft={draft} setDraft={setDraft} onSave={saveEdit} onCancel={cancelEdit} />
                  ) : (
                    <tr key={t.id} style={styles.tr}>
                      <td style={styles.td}>{t.date || "—"}</td>
                      <td style={styles.td}>{t.exchange || "—"}</td>
                      <td style={{ ...styles.td, fontWeight: 600 }}>{t.symbol || "—"}</td>
                      <td style={styles.td}>
                        <span style={{ ...styles.sideBadge, color: t.side === "short" ? COLORS.loss : COLORS.profit, borderColor: t.side === "short" ? COLORS.loss : COLORS.profit }}>
                          {t.side === "short" ? "SHORT" : "LONG"}
                        </span>
                      </td>
                      <td style={styles.td}>{t.entryPrice !== null ? fmt(t.entryPrice, 4) : "—"}</td>
                      <td style={styles.td}>{t.exitPrice !== null ? fmt(t.exitPrice, 4) : "—"}</td>
                      <td style={styles.td}>{t.size !== null ? fmt(t.size, 4) : "—"}</td>
                      <td style={styles.td}>{t.leverage !== null ? `${fmt(t.leverage, 1)}x` : "—"}</td>
                      {currencyMode !== "usd" && (
                        <td style={styles.td}>
                          {(() => {
                            const info = rateInfoForTrade(t);
                            if (!info) return "—";
                            return (
                              <>
                                {info.text}
                                {info.badge && (
                                  <div style={{ ...styles.tdSub, color: info.badgeColor }}>{info.badge}</div>
                                )}
                              </>
                            );
                          })()}
                        </td>
                      )}
                      <td style={{ ...styles.td, fontWeight: 700, color: t.pnl > 0 ? COLORS.profit : t.pnl < 0 ? COLORS.loss : COLORS.text }}>
                        {t.pnl === null
                          ? "—"
                          : currencyMode === "usd"
                          ? fmtUsd(t.pnl)
                          : isRowPending(t)
                          ? "取得中…"
                          : fmtJpyRaw(convertedAmount(t.pnl, t))}
                        {t.pnl !== null && currencyMode !== "usd" && !isRowPending(t) && (
                          <div style={styles.tdSub}>{fmtUsd(t.pnl)}</div>
                        )}
                      </td>
                      <td style={styles.td}>
                        {t.fee === null
                          ? "—"
                          : currencyMode === "usd"
                          ? `$${fmt(t.fee)}`
                          : isRowPending(t)
                          ? "…"
                          : fmtJpyRaw(convertedAmount(t.fee, t))}
                      </td>
                      <td style={styles.td}>
                        <span style={{ ...styles.statusBadge, opacity: t.status === "open" ? 1 : 0.5 }}>
                          {t.status === "open" ? "オープン" : "決済済"}
                        </span>
                      </td>
                      <td style={{ ...styles.td, whiteSpace: "nowrap" }}>
                        <button style={styles.iconBtn} onClick={() => startEdit(t)} aria-label="編集">
                          <Pencil size={14} />
                        </button>
                        <button style={styles.iconBtn} onClick={() => deleteTrade(t.id)} aria-label="削除">
                          <Trash2 size={14} />
                        </button>
                      </td>
                    </tr>
                  )
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div style={styles.footNote}>
        データはこの端末のブラウザ内に保存されます。スクショの自動読み取りは間違えることがあるため、追加後に内容を確認してください。
        為替レートは自動取得(open.er-api.com)、右上のレート表示をタップすると手動入力もできます。
      </div>

      <style>{`
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
      `}</style>
    </div>
  );
}

function StatCard({ label, value, sub }) {
  return (
    <div style={styles.statCard}>
      <div style={styles.statLabel}>{label}</div>
      <div style={styles.statValue}>{value}</div>
      <div style={styles.statSub}>{sub}</div>
    </div>
  );
}

function EditRow({ draft, setDraft, onSave, onCancel }) {
  const set = (k) => (e) => {
    const raw = e.target.value;
    const numeric = ["entryPrice", "exitPrice", "size", "leverage", "pnl", "fee"];
    setDraft({ ...draft, [k]: numeric.includes(k) ? (raw === "" ? null : Number(raw)) : raw });
  };
  const inputStyle = { ...styles.editInput };
  return (
    <tr style={{ ...styles.tr, background: "#1D2230" }}>
      <td style={styles.td}><input style={{ ...inputStyle, width: 90 }} value={draft.date || ""} onChange={set("date")} placeholder="日時" /></td>
      <td style={styles.td}><input style={{ ...inputStyle, width: 70 }} value={draft.exchange || ""} onChange={set("exchange")} placeholder="取引所" /></td>
      <td style={styles.td}><input style={{ ...inputStyle, width: 80 }} value={draft.symbol || ""} onChange={set("symbol")} placeholder="BTCUSDT" /></td>
      <td style={styles.td}>
        <select style={inputStyle} value={draft.side} onChange={set("side")}>
          <option value="long">LONG</option>
          <option value="short">SHORT</option>
        </select>
      </td>
      <td style={styles.td}><input style={{ ...inputStyle, width: 80 }} type="number" value={draft.entryPrice ?? ""} onChange={set("entryPrice")} /></td>
      <td style={styles.td}><input style={{ ...inputStyle, width: 80 }} type="number" value={draft.exitPrice ?? ""} onChange={set("exitPrice")} /></td>
      <td style={styles.td}><input style={{ ...inputStyle, width: 70 }} type="number" value={draft.size ?? ""} onChange={set("size")} /></td>
      <td style={styles.td}><input style={{ ...inputStyle, width: 55 }} type="number" value={draft.leverage ?? ""} onChange={set("leverage")} /></td>
      <td style={styles.td}><input style={{ ...inputStyle, width: 75 }} type="number" value={draft.pnl ?? ""} onChange={set("pnl")} /></td>
      <td style={styles.td}><input style={{ ...inputStyle, width: 60 }} type="number" value={draft.fee ?? ""} onChange={set("fee")} /></td>
      <td style={styles.td}>
        <select style={inputStyle} value={draft.status} onChange={set("status")}>
          <option value="closed">決済済</option>
          <option value="open">オープン</option>
        </select>
      </td>
      <td style={{ ...styles.td, whiteSpace: "nowrap" }}>
        <button style={styles.iconBtn} onClick={onSave} aria-label="保存"><Check size={14} color={COLORS.profit} /></button>
        <button style={styles.iconBtn} onClick={onCancel} aria-label="取消"><X size={14} color={COLORS.loss} /></button>
      </td>
    </tr>
  );
}

// ---------- design tokens ----------

const COLORS = {
  bg: "#0F1218",
  surface: "#171B24",
  surfaceAlt: "#1B2029",
  border: "#262B36",
  text: "#E8EAED",
  textDim: "#8B93A7",
  gold: "#D9A441",
  profit: "#3ECF8E",
  loss: "#F0576B",
};

const styles = {
  page: {
    minHeight: "100vh",
    background: COLORS.bg,
    color: COLORS.text,
    fontFamily: "'Space Grotesk', sans-serif",
    padding: "20px 16px 60px",
    maxWidth: 980,
    margin: "0 auto",
  },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    flexWrap: "wrap",
    marginBottom: 18,
  },
  eyebrow: {
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 11,
    letterSpacing: 3,
    color: COLORS.gold,
    marginBottom: 4,
  },
  title: { fontSize: 22, fontWeight: 700, margin: 0 },
  btnPrimary: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    background: COLORS.gold,
    color: "#181206",
    border: "none",
    borderRadius: 8,
    padding: "10px 16px",
    fontWeight: 700,
    fontSize: 13,
    cursor: "pointer",
    fontFamily: "'Space Grotesk', sans-serif",
  },
  btnGhost: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    background: "transparent",
    color: COLORS.textDim,
    border: `1px solid ${COLORS.border}`,
    borderRadius: 8,
    padding: "6px 12px",
    fontSize: 12,
    cursor: "pointer",
    fontFamily: "'Space Grotesk', sans-serif",
  },
  errorBanner: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    background: "#2A171C",
    border: `1px solid ${COLORS.loss}55`,
    color: "#F5A5B0",
    padding: "8px 12px",
    borderRadius: 8,
    fontSize: 12,
    marginBottom: 12,
  },
  successBanner: {
    background: "#152A22",
    border: `1px solid ${COLORS.profit}55`,
    color: "#9CE8C4",
    padding: "8px 12px",
    borderRadius: 8,
    fontSize: 12,
    marginBottom: 12,
  },
  hero: {
    background: `linear-gradient(135deg, ${COLORS.surface}, ${COLORS.surfaceAlt})`,
    border: `1px solid ${COLORS.border}`,
    borderRadius: 14,
    padding: "22px 24px",
    marginBottom: 16,
  },
  heroLabel: {
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 12,
    color: COLORS.textDim,
    letterSpacing: 2,
    marginBottom: 6,
  },
  heroNumber: {
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 40,
    fontWeight: 700,
    display: "flex",
    alignItems: "center",
    gap: 10,
    lineHeight: 1.1,
  },
  heroJpy: {
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 16,
    fontWeight: 600,
    opacity: 0.85,
    marginTop: 2,
  },
  heroSub: { color: COLORS.textDim, fontSize: 12, marginTop: 6 },
  rateWidget: { display: "flex", alignItems: "center", gap: 6 },
  modeToggle: {
    display: "flex",
    gap: 6,
    marginBottom: 14,
    flexWrap: "wrap",
  },
  modeBtn: {
    background: "transparent",
    color: COLORS.textDim,
    border: `1px solid ${COLORS.border}`,
    borderRadius: 20,
    padding: "6px 14px",
    fontSize: 12,
    cursor: "pointer",
    fontFamily: "'Space Grotesk', sans-serif",
  },
  modeBtnActive: {
    background: COLORS.gold,
    color: "#181206",
    borderColor: COLORS.gold,
    fontWeight: 700,
  },
  walletRow: { display: "flex", gap: 10, flexWrap: "wrap" },
  walletNote: { color: COLORS.textDim, fontSize: 11, marginTop: 10, lineHeight: 1.6 },
  linkBtn: {
    background: "transparent",
    border: "none",
    color: COLORS.gold,
    fontSize: 11,
    cursor: "pointer",
    padding: 0,
    marginTop: 10,
    textDecoration: "underline",
    fontFamily: "'Space Grotesk', sans-serif",
  },
  pasteBox: {
    marginTop: 14,
    paddingTop: 14,
    borderTop: `1px solid ${COLORS.border}`,
  },
  pasteTitle: { fontSize: 12, fontWeight: 700, marginBottom: 6 },
  codeBlock: {
    background: COLORS.bg,
    border: `1px solid ${COLORS.border}`,
    borderRadius: 8,
    padding: "10px 12px",
    fontSize: 11,
    color: COLORS.textDim,
    overflowX: "auto",
    fontFamily: "'JetBrains Mono', monospace",
    margin: "8px 0",
    whiteSpace: "pre",
  },
  pasteArea: {
    width: "100%",
    background: COLORS.bg,
    border: `1px solid ${COLORS.border}`,
    borderRadius: 8,
    color: COLORS.text,
    padding: 10,
    fontSize: 11,
    fontFamily: "'JetBrains Mono', monospace",
    marginBottom: 8,
    resize: "vertical",
  },
  rateBtn: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    background: "transparent",
    color: COLORS.textDim,
    border: `1px solid ${COLORS.border}`,
    borderRadius: 8,
    padding: "8px 12px",
    fontSize: 12,
    fontFamily: "'JetBrains Mono', monospace",
    cursor: "pointer",
  },
  tdSub: { fontSize: 10, fontWeight: 400, opacity: 0.6, marginTop: 1 },
  periodDetailWrap: {
    background: COLORS.bg,
    padding: "8px 10px 10px 30px",
    overflowX: "auto",
  },
  statGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
    gap: 10,
    marginBottom: 16,
  },
  statCard: {
    background: COLORS.surface,
    border: `1px solid ${COLORS.border}`,
    borderRadius: 12,
    padding: "14px 16px",
  },
  statLabel: { fontSize: 11, color: COLORS.textDim, marginBottom: 6 },
  statValue: { fontFamily: "'JetBrains Mono', monospace", fontSize: 20, fontWeight: 700 },
  statSub: { fontSize: 11, color: COLORS.textDim, marginTop: 4 },
  card: {
    background: COLORS.surface,
    border: `1px solid ${COLORS.border}`,
    borderRadius: 12,
    padding: 18,
    marginBottom: 16,
  },
  cardTitle: { fontSize: 14, fontWeight: 600, marginBottom: 12 },
  tableHeaderRow: { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 },
  emptyChart: {
    color: COLORS.textDim,
    fontSize: 13,
    padding: "30px 0",
    textAlign: "center",
  },
  emptyState: {
    color: COLORS.textDim,
    fontSize: 13,
    padding: "24px 0",
    textAlign: "center",
    lineHeight: 1.7,
  },
  tableWrap: { overflowX: "auto" },
  table: { width: "100%", borderCollapse: "collapse", fontSize: 12.5, fontFamily: "'JetBrains Mono', monospace" },
  th: {
    textAlign: "left",
    padding: "8px 10px",
    color: COLORS.textDim,
    fontWeight: 500,
    borderBottom: `1px solid ${COLORS.border}`,
    whiteSpace: "nowrap",
    fontSize: 11,
  },
  tr: { borderBottom: `1px solid ${COLORS.border}22` },
  td: { padding: "8px 10px", whiteSpace: "nowrap" },
  sideBadge: {
    border: "1px solid",
    borderRadius: 4,
    padding: "2px 6px",
    fontSize: 10,
    fontWeight: 700,
  },
  statusBadge: { fontSize: 11 },
  iconBtn: {
    background: "transparent",
    border: "none",
    color: COLORS.textDim,
    cursor: "pointer",
    padding: 4,
  },
  editInput: {
    background: COLORS.bg,
    border: `1px solid ${COLORS.border}`,
    borderRadius: 6,
    color: COLORS.text,
    padding: "4px 6px",
    fontSize: 12,
    width: "100%",
  },
  footNote: { color: COLORS.textDim, fontSize: 11, textAlign: "center", marginTop: 8, lineHeight: 1.6 },
};
