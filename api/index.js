import express from "express";
import crypto from "crypto";
import fs from "fs/promises";
import {
  init,
  shutdown,
  downloadBudget,
  getAccounts,
  getCategories,
  getBudgetMonth,
  importTransactions,
} from "@actual-app/api";

// ---- Global crash guards ----
process.on("unhandledRejection", (err) => console.error("unhandledRejection:", err));
process.on("uncaughtException", (err) => console.error("uncaughtException:", err));

const {
  ACTUAL_SERVER_URL,
  ACTUAL_PASSWORD,
  ACTUAL_BUDGET_ID,
  ACTUAL_FILE_PASSWORD,
  OLLAMA_URL,
  OLLAMA_MODEL = "mistral",
  PORT = "8787",
  API_TOKEN,
  IMPORT_NOTES_PREFIX = "SMS",
  TIMEZONE = "Asia/Kolkata",
  ACTUAL_DATADIR = "/tmp/actual-data",
  LOG_OLLAMA_RAW = "0",
} = process.env;

function requireEnv(name, value) {
  if (!value) throw new Error(`Missing required env var: ${name}`);
}
requireEnv("ACTUAL_SERVER_URL", ACTUAL_SERVER_URL);
requireEnv("ACTUAL_PASSWORD", ACTUAL_PASSWORD);
requireEnv("ACTUAL_BUDGET_ID", ACTUAL_BUDGET_ID);
requireEnv("OLLAMA_URL", OLLAMA_URL);

const app = express();
app.use(express.json({ limit: "256kb" }));

async function ensureDirExists(path) {
  await fs.mkdir(path, { recursive: true });
}

function todayISO(tz) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const y = parts.find((p) => p.type === "year")?.value;
  const m = parts.find((p) => p.type === "month")?.value;
  const d = parts.find((p) => p.type === "day")?.value;
  return `${y}-${m}-${d}`;
}

function sha256(s) {
  return crypto.createHash("sha256").update(s).digest("hex");
}

function toMinorUnits(amount) {
  return Math.round(amount * 100);
}

function promptForSMS(sms, { accounts, categories }) {
  const accountsList = accounts.map((a) => `  - ${a.name}`).join("\n");
  const categoriesList = categories.map((c) => `  - ${c.name}`).join("\n");

  return `
You are a financial transaction parser.

You will receive ONE SMS message from an Indian bank, card issuer, insurer, or UPI system.

FIRST DECIDE:
Is this SMS confirming a COMPLETED financial transaction
(where money has already been debited or credited)?

Examples of NOT a transaction:
- premium due reminders, upcoming charges, standing instruction notices
- payment reminders, OTPs, promotions, warnings, balance alerts
- "will be deducted", "due on", "scheduled", "if paid", "may be charged"

IF NOT a completed transaction: return JSON with ALL fields set to null

AVAILABLE ACCOUNTS:
${accountsList}

AVAILABLE CATEGORIES:
${categoriesList}

RULES:
1. AMOUNT SIGN:
   - DEBIT/SPENT/PAID/WITHDRAWN/PURCHASE = NEGATIVE (e.g., "Rs.500 debited" → -500)
   - CREDIT/RECEIVED/REFUND/CASHBACK = POSITIVE (e.g., "Rs.100 credited" → 100)

2. ACCOUNT: Match to an account from the AVAILABLE ACCOUNTS list above.
   - First try to match by last 4 digits in SMS (e.g., "Card 6101", "XX2979")
   - If no digit match, match by bank/card name (e.g., "HSBC" in SMS → "HSBC ****0001" from list)
   - IMPORTANT: Always return an exact account name from the list above, never invent or modify account names

3. CATEGORY: Pick the best matching category name from the list, or null if uncertain

4. Output ONLY valid JSON, no markdown, no explanation
5. Date format: YYYY-MM-DD or null
6. Description: merchant name only, no card numbers

OUTPUT FORMAT:
{
  "amount": number | null,
  "description": string | null,
  "date": string | null,
  "account": string | null,
  "category": string | null
}

SMS:
${sms}`.trim();
}

// --- JSON extraction helpers ---
function stripCodeFences(s) {
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  return fenced ? fenced[1] : s;
}

function extractFirstJsonObjectString(s) {
  const start = s.indexOf("{");
  if (start === -1) throw new Error("No '{' found in model output");

  let depth = 0;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
    if (depth === 0) return s.slice(start, i + 1);
  }
  throw new Error("Unterminated JSON object in model output");
}

function parseModelJsonFromText(text) {
  const stripped = stripCodeFences(text).trim();
  try {
    return JSON.parse(stripped);
  } catch {
    const objStr = extractFirstJsonObjectString(stripped);
    return JSON.parse(objStr);
  }
}

// --- Ollama NDJSON-safe chat ---
async function ollamaChatText(payload) {
  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Ollama error ${res.status}: ${t}`);
  }

  const body = await res.text();

  try {
    const obj = JSON.parse(body);
    const content = obj?.message?.content;
    if (typeof content === "string") return content;
    if (typeof content === "object" && content !== null) return JSON.stringify(content);
    return String(content ?? "");
  } catch {
    if (LOG_OLLAMA_RAW === "1") {
      console.error("---- OLLAMA NDJSON RAW (first 2000 chars) ----");
      console.error(body.slice(0, 2000));
      console.error("---- END ----");
    }

    let assembled = "";
    const lines = body.split("\n").filter(Boolean);
    for (const line of lines) {
      let chunk;
      try {
        chunk = JSON.parse(line);
      } catch {
        continue;
      }
      const part = chunk?.message?.content;
      if (typeof part === "string") assembled += part;

      if (chunk?.done === true) break;
    }

    if (!assembled) {
      throw new Error("Failed to assemble model output from NDJSON stream");
    }
    return assembled;
  }
}

async function ollamaParse(sms, { accounts, categories }) {
  const payload = {
    model: OLLAMA_MODEL,
    messages: [{ role: "user", content: promptForSMS(sms, { accounts, categories }) }],
    options: { temperature: 0 },
    format: {
      type: "object",
      properties: {
        amount: { type: ["number", "null"] },
        description: { type: ["string", "null"] },
        date: { type: ["string", "null"] },
        account: { type: ["string", "null"] },
        category: { type: ["string", "null"] },
      },
      required: ["amount", "description", "date", "account", "category"],
    },
    stream: false,
  };

  const contentText = await ollamaChatText(payload);
  return parseModelJsonFromText(contentText);
}

function validateParsed(p) {
  if (!p || typeof p !== "object") throw new Error("LLM output is not an object");
  const { amount, description, date, account, category } = p;

  if (!(amount === null || typeof amount === "number")) throw new Error("amount must be number or null");
  if (!(description === null || typeof description === "string")) throw new Error("description must be string or null");
  if (!(date === null || typeof date === "string")) throw new Error("date must be string or null");
  if (!(account === null || typeof account === "string")) throw new Error("account must be string or null");
  if (!(category === null || typeof category === "string")) throw new Error("category must be string or null");

  return { amount, description, date, account, category };
}

// --- Matching helpers ---
function extractDigits(str) {
  // Extract all 4-digit sequences
  const matches = str.match(/\d{4}/g);
  return matches || [];
}

function matchAccount(accountName, sms) {
  // Try exact match first
  let account = actualAccounts.find((a) =>
    a.name.toLowerCase() === accountName?.toLowerCase()
  );
  if (account) return account;

  // Try partial match on name
  if (accountName) {
    account = actualAccounts.find((a) =>
      a.name.toLowerCase().includes(accountName.toLowerCase()) ||
      accountName.toLowerCase().includes(a.name.toLowerCase().replace(/[*\s]/g, ''))
    );
    if (account) return account;
  }

  // Fallback: extract digits from SMS and match to account
  const smsDigits = extractDigits(sms);
  for (const digits of smsDigits) {
    account = actualAccounts.find((a) => a.name.includes(digits));
    if (account) return account;
  }

  return null;
}

function matchCategory(categoryName) {
  if (!categoryName) return null;

  const search = categoryName.toLowerCase().replace(/[^\w\s]/g, '');

  // Try exact match
  let category = actualCategories.find((c) =>
    c.name.toLowerCase() === categoryName.toLowerCase()
  );
  if (category) return category;

  // Try partial match
  category = actualCategories.find((c) => {
    const name = c.name.toLowerCase().replace(/[^\w\s]/g, '');
    return name.includes(search) || search.includes(name);
  });

  return category || null;
}

// --- Actual (lazy init, retry-safe) ---
let actualReady = false;
let actualAccounts = [];
let actualCategories = [];

async function ensureActualReady() {
  if (actualReady && actualAccounts.length > 0) return;

  await ensureDirExists(ACTUAL_DATADIR);

  try {
    await init({
      dataDir: ACTUAL_DATADIR,
      serverURL: ACTUAL_SERVER_URL,
      password: ACTUAL_PASSWORD,
    });

    await downloadBudget(ACTUAL_BUDGET_ID, { password: ACTUAL_FILE_PASSWORD });

    const accounts = await getAccounts();
    actualAccounts = accounts.filter((a) => !a.closed);

    if (actualAccounts.length === 0) {
      throw new Error("No active accounts found in Actual Budget");
    }

    const categories = await getCategories();
    actualCategories = categories.filter((c) => !c.hidden && c.name);

    actualReady = true;
  } catch (e) {
    try { await shutdown(); } catch {}
    actualReady = false;
    actualAccounts = [];
    actualCategories = [];
    throw e;
  }
}

function getActualData() {
  return {
    accounts: actualAccounts,
    categories: actualCategories,
  };
}

async function importIntoActual({ sms, amount, description, date, account: accountName, category: categoryName }) {
  await ensureActualReady();

  // Match account by name (with fallback to SMS digits)
  const account = matchAccount(accountName, sms);
  if (!account) {
    const validNames = actualAccounts.map((a) => a.name).join(", ");
    throw new Error(`Could not match account "${accountName}". Available: ${validNames}`);
  }
  console.log(`Matched account: "${accountName}" -> ${account.name} (${account.id})`);

  // Match category by name
  const category = matchCategory(categoryName);
  const categoryId = category?.id || null;
  if (categoryName && category) {
    console.log(`Matched category: "${categoryName}" -> ${category.name}`);
  }

  const finalDate = date && date.length >= 10 ? date : todayISO(TIMEZONE);
  const amountInt = toMinorUnits(amount);

  const idKey = sha256(`${sms}||${finalDate}||${amountInt}||${description ?? ""}`).slice(0, 32);

  const tx = {
    account: account.id,
    date: finalDate,
    amount: amountInt,
    payee_name: description || null,
    category: categoryId,
    notes: `${IMPORT_NOTES_PREFIX}: ${description ?? ""}`.trim(),
    imported_id: `sms:${idKey}`,
    cleared: false,
  };

  const result = await importTransactions(account.id, [tx]);
  return { finalDate, tx, result };
}

// --- Auth middleware ---
function requireAuth(req, res, next) {
  if (!API_TOKEN) return next();
  const token = req.header("x-api-token") || req.header("authorization")?.replace("Bearer ", "");
  if (token !== API_TOKEN) return res.status(401).json({ ok: false, error: "unauthorized" });
  next();
}

// --- Routes ---
app.get("/health", (req, res) => res.json({ ok: true }));

app.post("/ingest", requireAuth, async (req, res) => {
  try {
    const sms = req.body?.sms;
    if (!sms || typeof sms !== "string") return res.status(400).json({ ok: false, error: "missing sms string" });

    await ensureActualReady();
    const actualData = getActualData();
    const parsed = validateParsed(await ollamaParse(sms, actualData));

    if (parsed.amount === null) {
      return res.json({ ok: true, ignored: true, parsed });
    }

    const imported = await importIntoActual({ sms, ...parsed });
    res.json({ ok: true, ignored: false, parsed, imported });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message ?? e) });
  }
});

// --- Budget endpoint ---
function getCurrentMonth(tz) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
  }).formatToParts(new Date());
  const y = parts.find((p) => p.type === "year")?.value;
  const m = parts.find((p) => p.type === "month")?.value;
  return `${y}-${m}`;
}

function getDaysInMonth(year, month) {
  return new Date(year, month, 0).getDate();
}

function getDaysLeftInMonth(tz) {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const y = parseInt(parts.find((p) => p.type === "year")?.value);
  const m = parseInt(parts.find((p) => p.type === "month")?.value);
  const d = parseInt(parts.find((p) => p.type === "day")?.value);
  const totalDays = getDaysInMonth(y, m);
  return totalDays - d;
}

app.get("/budget", requireAuth, async (req, res) => {
  try {
    await ensureActualReady();

    const month = getCurrentMonth(TIMEZONE);
    const data = await getBudgetMonth(month);

    // totalIncome = budget available (positive)
    // totalSpent = money spent (negative)
    // totalBalance = remaining (negative if overspent)
    const totalBudgeted = data.totalIncome || 0;
    const totalSpent = data.totalSpent || 0;
    const remaining = data.totalBalance || 0;

    const [year, monthNum] = month.split("-").map(Number);
    const totalDays = getDaysInMonth(year, monthNum);
    const daysLeft = getDaysLeftInMonth(TIMEZONE);
    const daysPassed = totalDays - daysLeft;

    const perDaySpent = daysPassed > 0 ? Math.round(Math.abs(totalSpent) / daysPassed) : 0;

    const monthName = new Date(year, monthNum - 1).toLocaleString("en-US", { month: "long" });

    res.json({
      ok: true,
      month,
      monthName,
      totalBudgeted: totalBudgeted / 100,
      totalSpent: Math.abs(totalSpent) / 100,
      remaining: Math.abs(remaining) / 100,
      isOverspent: remaining < 0,
      daysLeft,
      daysPassed,
      perDaySpent: perDaySpent / 100,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message ?? e) });
  }
});

// --- Start server ---
const server = app.listen(Number(PORT), "0.0.0.0", () => {
  console.log(`api listening on :${PORT}`);
});

// Graceful shutdown
async function gracefulExit() {
  try { await shutdown(); } catch {}
  server.close(() => process.exit(0));
}
process.on("SIGINT", gracefulExit);
process.on("SIGTERM", gracefulExit);