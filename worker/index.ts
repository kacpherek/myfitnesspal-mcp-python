import * as cheerio from "cheerio";

interface Env {
  MCP_PATH_TOKEN: string;
  MFP_COOKIE?: string;
  MFP_USERNAME?: string;
  MFP_PASSWORD?: string;
}

type JsonRpcId = string | number | null;
type JsonRpcRequest = {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method: string;
  params?: { name?: string; arguments?: Record<string, unknown> };
};

type Auth = {
  cookie: string;
  accessToken: string;
  userId: string;
  username: string;
};

const MFP = "https://www.myfitnesspal.com";
const API = "https://api.myfitnesspal.com";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36";

const tools = [
  tool("mfp_get_diary", "Get food diary, totals, goals, water and notes.", {
    date: dateProperty(),
  }),
  tool("mfp_search_food", "Search the MyFitnessPal food database.", {
    query: { type: "string", minLength: 1, maxLength: 200 },
    limit: { type: "integer", minimum: 1, maximum: 50, default: 10 },
  }, ["query"]),
  tool("mfp_get_food_details", "Get detailed nutrition for a food ID.", {
    mfp_id: { type: "string", minLength: 1 },
  }, ["mfp_id"]),
  tool("mfp_get_measurements", "Get body measurement history.", {
    measurement: { type: "string", default: "Weight" },
    start_date: dateProperty(),
    end_date: dateProperty(),
  }),
  tool("mfp_set_measurement", "Log a body measurement.", {
    measurement: { type: "string", default: "Weight" },
    value: { type: "number", exclusiveMinimum: 0 },
  }, ["value"]),
  tool("mfp_get_exercises", "Get exercises logged for a date.", {
    date: dateProperty(),
  }),
  tool("mfp_get_goals", "Get daily nutrition goals.", {
    date: dateProperty(),
  }),
  tool("mfp_set_goals", "Update daily calorie and macro goals.", {
    calories: { type: "integer", minimum: 500, maximum: 10000 },
    protein: { type: "integer", minimum: 0, maximum: 1000 },
    carbohydrates: { type: "integer", minimum: 0, maximum: 2000 },
    fat: { type: "integer", minimum: 0, maximum: 500 },
  }),
  tool("mfp_get_water", "Get water intake for a date.", {
    date: dateProperty(),
  }),
  tool("mfp_add_food_to_diary", "Add a food item to a diary meal.", {
    mfp_id: { type: "string", minLength: 1 },
    meal: { type: "string", default: "Breakfast" },
    date: dateProperty(),
    quantity: { type: "number", exclusiveMinimum: 0, maximum: 100, default: 1 },
    unit: { type: "string" },
  }, ["mfp_id"]),
  tool("mfp_set_water", "Set water intake in cups.", {
    cups: { type: "number", minimum: 0, maximum: 50 },
    date: dateProperty(),
  }, ["cups"]),
  tool("mfp_get_report", "Get a nutrition report over a date range.", {
    report_name: { type: "string", default: "Net Calories" },
    start_date: dateProperty(),
    end_date: dateProperty(),
  }),
];

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (!env.MCP_PATH_TOKEN || url.pathname !== `/${env.MCP_PATH_TOKEN}`) {
      return new Response("Not found", { status: 404 });
    }
    if (request.method === "GET") {
      return json({ name: "myfitnesspal-mcp", transport: "streamable-http" });
    }
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    let rpc: JsonRpcRequest;
    try {
      rpc = await request.json();
    } catch {
      return rpcError(null, -32700, "Parse error");
    }

    if (rpc.method.startsWith("notifications/")) {
      return new Response(null, { status: 202 });
    }
    if (rpc.method === "initialize") {
      return rpcResult(rpc.id, {
        protocolVersion: "2025-03-26",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "myfitnesspal-mcp", version: "1.0.0" },
      });
    }
    if (rpc.method === "ping") return rpcResult(rpc.id, {});
    if (rpc.method === "tools/list") return rpcResult(rpc.id, { tools });
    if (rpc.method !== "tools/call" || !rpc.params?.name) {
      return rpcError(rpc.id, -32601, "Method not found");
    }

    try {
      const result = await callTool(rpc.params.name, rpc.params.arguments ?? {}, env);
      return rpcResult(rpc.id, {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return rpcResult(rpc.id, {
        content: [{ type: "text", text: `Error: ${message}` }],
        isError: true,
      });
    }
  },
} satisfies ExportedHandler<Env>;

function tool(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[] = [],
) {
  return {
    name,
    description,
    inputSchema: { type: "object", properties, required, additionalProperties: false },
  };
}

function dateProperty() {
  return { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" };
}

async function callTool(name: string, args: Record<string, unknown>, env: Env) {
  const auth = await authenticate(env);
  switch (name) {
    case "mfp_get_diary":
      return getDiary(auth, stringArg(args.date) ?? today());
    case "mfp_search_food":
      return searchFood(auth, requiredString(args.query, "query"), numberArg(args.limit, 10));
    case "mfp_get_food_details":
      return getFoodDetails(auth, requiredString(args.mfp_id, "mfp_id"));
    case "mfp_get_measurements":
      return getMeasurements(
        auth,
        stringArg(args.measurement) ?? "Weight",
        stringArg(args.start_date) ?? daysAgo(30),
        stringArg(args.end_date) ?? today(),
      );
    case "mfp_set_measurement":
      return setMeasurement(
        auth,
        stringArg(args.measurement) ?? "Weight",
        requiredNumber(args.value, "value"),
      );
    case "mfp_get_exercises":
      return getExercises(auth, stringArg(args.date) ?? today());
    case "mfp_get_goals": {
      const diary = await getDiary(auth, stringArg(args.date) ?? today());
      return { date: diary.date, goals: diary.daily_goals };
    }
    case "mfp_set_goals":
      return setGoals(auth, args);
    case "mfp_get_water":
      return getWater(auth, stringArg(args.date) ?? today());
    case "mfp_add_food_to_diary":
      return addFood(auth, {
        id: requiredString(args.mfp_id, "mfp_id"),
        meal: stringArg(args.meal) ?? "Breakfast",
        date: stringArg(args.date) ?? today(),
        quantity: numberArg(args.quantity, 1),
        unit: stringArg(args.unit),
      });
    case "mfp_set_water":
      return setWater(
        auth,
        requiredNumber(args.cups, "cups"),
        stringArg(args.date) ?? today(),
      );
    case "mfp_get_report":
      return getReport(
        auth,
        stringArg(args.report_name) ?? "Net Calories",
        stringArg(args.start_date) ?? daysAgo(7),
        stringArg(args.end_date) ?? today(),
      );
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

async function authenticate(env: Env): Promise<Auth> {
  let cookie = env.MFP_COOKIE?.trim();
  if (!cookie) {
    if (!env.MFP_USERNAME || !env.MFP_PASSWORD) {
      throw new Error("Configure MFP_COOKIE or MFP_USERNAME and MFP_PASSWORD secrets.");
    }
    cookie = await login(env.MFP_USERNAME, env.MFP_PASSWORD);
  }

  const tokenResponse = await mfpRequest(`${MFP}/user/auth_token?refresh=true`, cookie);
  if (!tokenResponse.ok || !tokenResponse.headers.get("content-type")?.includes("json")) {
    throw new Error("MyFitnessPal session is invalid or expired.");
  }
  const token = await tokenResponse.json<{
    access_token: string;
    user_id: string;
  }>();

  const metadata = await apiRequest(
    `/v2/users/${token.user_id}?fields[]=profiles&fields[]=diary_preferences`,
    cookie,
    token.access_token,
    token.user_id,
  );
  const metadataJson = await expectJson<{ item: { username: string } }>(metadata);
  return {
    cookie,
    accessToken: token.access_token,
    userId: token.user_id,
    username: metadataJson.item.username,
  };
}

async function login(username: string, password: string): Promise<string> {
  const csrfResponse = await fetch(`${MFP}/api/auth/csrf`, {
    headers: { "user-agent": USER_AGENT, accept: "application/json" },
    redirect: "manual",
  });
  const csrf = await expectJson<{ csrfToken: string }>(csrfResponse);
  let cookie = responseCookies(csrfResponse);
  const body = new URLSearchParams({
    csrfToken: csrf.csrfToken,
    username,
    password,
    callbackUrl: MFP,
    json: "true",
  });
  const loginResponse = await fetch(`${MFP}/api/auth/callback/credentials`, {
    method: "POST",
    headers: {
      "user-agent": USER_AGENT,
      "content-type": "application/x-www-form-urlencoded",
      cookie,
    },
    body,
    redirect: "manual",
  });
  cookie = mergeCookies(cookie, responseCookies(loginResponse));
  if (loginResponse.status >= 400 || !cookie) {
    throw new Error("MyFitnessPal login failed.");
  }
  return cookie;
}

async function getDiary(auth: Auth, date: string) {
  const html = await htmlRequest(
    `${MFP}/food/diary/${encodeURIComponent(auth.username)}?date=${date}`,
    auth.cookie,
  );
  const $ = cheerio.load(html);
  const fields = $("tr.meal_header")
    .first()
    .find("td")
    .map((_, el) => normalizeNutrient($(el).text()))
    .get();
  const meals: Record<string, { entries: unknown[]; totals: Record<string, number> }> = {};

  $("tr.meal_header").each((_, header) => {
    const name = $(header).find("td").first().text().trim().toLowerCase();
    const entries: Array<{ name: string; nutrition_information: Record<string, number> }> = [];
    let row = $(header).next();
    while (row.length && !row.attr("class")) {
      const columns = row.find("td");
      if (columns.length) {
        const nutrition: Record<string, number> = {};
        columns.slice(1).each((index, column) => {
          if (fields[index + 1]) nutrition[fields[index + 1]] = numeric($(column).text());
        });
        entries.push({
          name: columns.first().text().replace(/\s+/g, " ").trim(),
          nutrition_information: nutrition,
        });
      }
      row = row.next();
    }
    const totals: Record<string, number> = {};
    for (const entry of entries) {
      for (const [key, value] of Object.entries(entry.nutrition_information)) {
        totals[key] = (totals[key] ?? 0) + value;
      }
    }
    meals[name] = { entries, totals };
  });

  const goals: Record<string, number> = {};
  const goalRow = $("tr.total").first().next();
  goalRow.find("td").slice(1).each((index, column) => {
    if (fields[index + 1]) goals[fields[index + 1]] = numeric($(column).text());
  });
  const dailyTotals: Record<string, number> = {};
  for (const meal of Object.values(meals)) {
    for (const [key, value] of Object.entries(meal.totals)) {
      dailyTotals[key] = (dailyTotals[key] ?? 0) + value;
    }
  }
  const [water, notes] = await Promise.all([getWater(auth, date), getNotes(auth, date)]);
  return {
    date,
    meals,
    daily_totals: dailyTotals,
    daily_goals: goals,
    water,
    notes,
  };
}

async function searchFood(auth: Auth, query: string, limit: number) {
  const searchUrl = `${MFP}/food/search`;
  const page = cheerio.load(await htmlRequest(searchUrl, auth.cookie));
  const csrf = page("input[name=authenticity_token]").first().attr("value");
  if (!csrf) throw new Error("Food search token was not found.");
  const response = await mfpRequest(searchUrl, auth.cookie, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", referer: searchUrl },
    body: new URLSearchParams({
      authenticity_token: csrf,
      search: query,
      date: today(),
      meal: "0",
    }),
  });
  const $ = cheerio.load(await response.text());
  const results: unknown[] = [];
  $("li.matched-food").slice(0, limit).each((_, item) => {
    const link = $(item).find(".search-title-container a").first();
    const info = $(item).find(".search-nutritional-info").text().trim().split(",");
    results.push({
      mfp_id: link.attr("data-external-id"),
      name: link.text().trim(),
      brand: info.slice(0, -2).join(",").trim(),
      calories: numeric(info.at(-1) ?? ""),
      verified: $(item).find(".verified-list-icon").length > 0,
    });
  });
  return { query, count: results.length, results };
}

async function getFoodDetails(auth: Auth, id: string) {
  const response = await apiRequest(
    `/v2/foods/${encodeURIComponent(id)}?fields[]=nutritional_contents&fields[]=serving_sizes&fields[]=confirmations`,
    auth.cookie,
    auth.accessToken,
    auth.userId,
  );
  return (await expectJson<{ item: unknown }>(response)).item;
}

async function getMeasurements(auth: Auth, measurement: string, start: string, end: string) {
  const values: Record<string, number> = {};
  for (let page = 1; page <= 20; page++) {
    const url = `${MFP}/measurements/edit?page=${page}&type=${encodeURIComponent(measurement)}`;
    const $ = cheerio.load(await htmlRequest(url, auth.cookie));
    const nextData = $("script#__NEXT_DATA__").text();
    if (!nextData) break;
    const parsed = JSON.parse(nextData) as {
      props?: { pageProps?: { dehydratedState?: { queries?: Array<{
        queryKey?: unknown[];
        state?: { data?: { items?: Array<{ date: string; value: number }> } };
      }> } } };
    };
    const items = parsed.props?.pageProps?.dehydratedState?.queries
      ?.flatMap((query) => query.state?.data?.items ?? []) ?? [];
    if (!items.length) break;
    for (const item of items) {
      if (item.date >= start && item.date <= end) values[item.date] = Number(item.value);
    }
    if (items.at(-1)!.date <= start) break;
  }
  const numbers = Object.values(values);
  return {
    measurement_type: measurement,
    start_date: start,
    end_date: end,
    count: numbers.length,
    values,
    summary: numbers.length ? {
      latest: numbers.at(-1),
      earliest: numbers[0],
      change: numbers.length > 1 ? numbers.at(-1)! - numbers[0] : 0,
      min: Math.min(...numbers),
      max: Math.max(...numbers),
      average: numbers.reduce((a, b) => a + b, 0) / numbers.length,
    } : undefined,
  };
}

async function setMeasurement(auth: Auth, measurement: string, value: number) {
  const url = `${MFP}/measurements/edit`;
  const $ = cheerio.load(await htmlRequest(url, auth.cookie));
  const csrf = $("form[action='/measurements/new'] input[name=authenticity_token]").first().attr("value");
  const nextData = JSON.parse($("script#__NEXT_DATA__").text()) as {
    props: { pageProps: { dehydratedState: { queries: Array<{
      queryKey: unknown[];
      state: { data: Array<{ description: string; id: number }> };
    }> } } };
  };
  const types = nextData.props.pageProps.dehydratedState.queries
    .flatMap((query) => Array.isArray(query.state.data) ? query.state.data : []);
  const type = types.find((entry) => entry.description === measurement)?.id;
  if (!csrf || !type) throw new Error(`Measurement '${measurement}' does not exist.`);
  const now = new Date();
  const response = await mfpRequest(`${MFP}/measurements/new`, auth.cookie, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      authenticity_token: csrf,
      "measurement[display_value]": String(value),
      type: String(type),
      "measurement[entry_date(2i)]": String(now.getUTCMonth() + 1),
      "measurement[entry_date(3i)]": String(now.getUTCDate()),
      "measurement[entry_date(1i)]": String(now.getUTCFullYear()),
    }),
  });
  if (!response.ok) throw new Error(`MyFitnessPal returned HTTP ${response.status}.`);
  return { success: true, measurement, value, date: today() };
}

async function getExercises(auth: Auth, date: string) {
  const $ = cheerio.load(
    await htmlRequest(`${MFP}/exercise/diary/${encodeURIComponent(auth.username)}?date=${date}`, auth.cookie),
  );
  const exercises: unknown[] = [];
  $("table.table0").each((_, table) => {
    const fields = $(table).find("thead tr td").map((__, td) => normalizeNutrient($(td).text())).get();
    const entries: unknown[] = [];
    $(table).find("tbody tr").each((__, row) => {
      if ($(row).attr("class")) return;
      const columns = $(row).find("td");
      if (!columns.length) return;
      const details: Record<string, number> = {};
      columns.slice(1).each((index, column) => {
        if (fields[index + 1]) details[fields[index + 1]] = numeric($(column).text());
      });
      entries.push({ name: columns.first().text().replace(/\s+/g, " ").trim(), details });
    });
    exercises.push({ type: fields[0], entries });
  });
  return { date, exercises };
}

async function setGoals(auth: Auth, args: Record<string, unknown>) {
  const date = today();
  const currentResponse = await apiRequest(
    `/v2/nutrient-goals?date=${date}`,
    auth.cookie,
    auth.accessToken,
    auth.userId,
  );
  const current = await expectJson<{ items: Array<Record<string, any>> }>(currentResponse);
  if (!current.items?.[0]) throw new Error("Current nutrition goals were not returned.");
  const item = structuredClone(current.items[0]);
  const base = item.default_goal;
  const energy = numberArg(args.calories, base.energy.value);
  const carbs = numberArg(args.carbohydrates, base.carbohydrates);
  const protein = numberArg(args.protein, base.protein);
  const fat = numberArg(args.fat, base.fat);
  item.valid_from = date;
  delete item.valid_to;
  delete item.default_group_id;
  delete item.updated_at;
  Object.assign(base, { carbohydrates: carbs, protein, fat, meal_goals: [] });
  base.energy.value = energy;
  for (const goal of item.daily_goals ?? []) {
    delete goal.group_id;
    Object.assign(goal, { carbohydrates: carbs, protein, fat, meal_goals: [] });
    goal.energy.value = energy;
  }
  const response = await apiRequest(
    "/v2/nutrient-goals",
    auth.cookie,
    auth.accessToken,
    auth.userId,
    { method: "POST", body: JSON.stringify({ item }) },
  );
  if (!response.ok) throw new Error(`MyFitnessPal returned HTTP ${response.status}.`);
  return { success: true, goals: { calories: energy, carbohydrates: carbs, protein, fat } };
}

async function getWater(auth: Auth, date: string) {
  const response = await mfpRequest(`${MFP}/food/water?date=${date}`, auth.cookie);
  const body = await expectJson<{ item: { milliliters: number } }>(response);
  const milliliters = Number(body.item.milliliters ?? 0);
  return { date, milliliters, cups: milliliters / 236.588 };
}

async function getNotes(auth: Auth, date: string) {
  const response = await mfpRequest(`${MFP}/food/note?date=${date}`, auth.cookie);
  if (!response.ok) return "";
  return (await response.json<{ item?: { body?: string } }>()).item?.body ?? "";
}

async function addFood(
  auth: Auth,
  input: { id: string; meal: string; date: string; quantity: number; unit?: string },
) {
  const diaryUrl = `${MFP}/food/diary/${encodeURIComponent(auth.username)}?date=${input.date}`;
  const $ = cheerio.load(await htmlRequest(diaryUrl, auth.cookie));
  const csrf = $("input[name=authenticity_token]").first().attr("value");
  if (!csrf) throw new Error("Diary token was not found.");
  const meal = { breakfast: "0", lunch: "1", dinner: "2", snacks: "3", snack: "3" }[
    input.meal.toLowerCase()
  ] ?? "0";
  const data: Record<string, string> = {
    authenticity_token: csrf,
    date: input.date,
    meal,
    food_id: input.id,
    quantity: String(input.quantity),
  };
  if (input.unit) data.unit = input.unit;
  const response = await mfpRequest(`${MFP}/food/diary/${encodeURIComponent(auth.username)}/add`, auth.cookie, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      referer: diaryUrl,
      "x-requested-with": "XMLHttpRequest",
    },
    body: new URLSearchParams(data),
  });
  if (!response.ok) throw new Error(`MyFitnessPal returned HTTP ${response.status}.`);
  return { success: true, ...input };
}

async function setWater(auth: Auth, cups: number, date: string) {
  const diaryUrl = `${MFP}/food/diary/${encodeURIComponent(auth.username)}?date=${date}`;
  const $ = cheerio.load(await htmlRequest(diaryUrl, auth.cookie));
  const csrf = $("input[name=authenticity_token]").first().attr("value");
  if (!csrf) throw new Error("Diary token was not found.");
  const response = await mfpRequest(`${MFP}/food/diary/${encodeURIComponent(auth.username)}/water`, auth.cookie, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      referer: diaryUrl,
      "x-requested-with": "XMLHttpRequest",
    },
    body: new URLSearchParams({
      authenticity_token: csrf,
      date,
      water: String(cups),
    }),
  });
  if (!response.ok) throw new Error(`MyFitnessPal returned HTTP ${response.status}.`);
  return { success: true, date, cups, milliliters: cups * 236.588 };
}

async function getReport(auth: Auth, name: string, start: string, end: string) {
  const days = Math.max(1, Math.ceil((Date.now() - Date.parse(`${start}T00:00:00Z`)) / 86400000));
  const path = `/reports/results/nutrition/${encodeURIComponent(name)}/${days}.json`;
  const response = await mfpRequest(`${MFP}${path}`, auth.cookie);
  const body = await expectJson<{ data?: Array<{ total: number }> }>(response);
  const values: Record<string, number> = {};
  for (let index = 0; index < (body.data?.length ?? 0); index++) {
    const date = new Date(Date.now() - ((body.data!.length - index - 1) * 86400000))
      .toISOString().slice(0, 10);
    if (date >= start && date <= end) values[date] = Number(body.data![index].total);
  }
  return { report_name: name, start_date: start, end_date: end, values };
}

async function htmlRequest(url: string, cookie: string) {
  const response = await mfpRequest(url, cookie);
  if (!response.ok) throw new Error(`MyFitnessPal returned HTTP ${response.status}.`);
  const text = await response.text();
  if (response.url.includes("/account/login")) throw new Error("MyFitnessPal session expired.");
  return text;
}

function mfpRequest(url: string, cookie: string, init: RequestInit = {}) {
  return fetch(url, {
    ...init,
    redirect: "follow",
    headers: {
      "user-agent": USER_AGENT,
      accept: "text/html,application/json",
      cookie,
      ...Object.fromEntries(new Headers(init.headers).entries()),
    },
  });
}

function apiRequest(
  path: string,
  cookie: string,
  accessToken: string,
  userId: string,
  init: RequestInit = {},
) {
  return fetch(`${API}${path}`, {
    ...init,
    headers: {
      "user-agent": USER_AGENT,
      accept: "application/json",
      "content-type": "application/json",
      cookie,
      authorization: `Bearer ${accessToken}`,
      "mfp-client-id": "mfp-main-js",
      "mfp-user-id": userId,
      ...Object.fromEntries(new Headers(init.headers).entries()),
    },
  });
}

async function expectJson<T>(response: Response): Promise<T> {
  if (!response.ok) throw new Error(`MyFitnessPal returned HTTP ${response.status}.`);
  const type = response.headers.get("content-type") ?? "";
  if (!type.includes("json")) throw new Error("MyFitnessPal returned an unexpected response.");
  return response.json<T>();
}

function responseCookies(response: Response) {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  const values = headers.getSetCookie?.() ?? [response.headers.get("set-cookie") ?? ""];
  return values
    .filter(Boolean)
    .map((value) => value.split(";", 1)[0])
    .join("; ");
}

function mergeCookies(...cookieHeaders: string[]) {
  const cookies = new Map<string, string>();
  for (const header of cookieHeaders) {
    for (const part of header.split(/;\s*/)) {
      const index = part.indexOf("=");
      if (index > 0) cookies.set(part.slice(0, index), part.slice(index + 1));
    }
  }
  return [...cookies].map(([key, value]) => `${key}=${value}`).join("; ");
}

function numeric(value: string) {
  const number = Number(value.replace(/[^\d.-]/g, ""));
  return Number.isFinite(number) ? number : 0;
}

function normalizeNutrient(value: string) {
  const key = value.trim().toLowerCase();
  return key === "carbs" ? "carbohydrates" : key;
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function daysAgo(days: number) {
  return new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
}

function stringArg(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function requiredString(value: unknown, name: string) {
  const result = stringArg(value);
  if (!result) throw new Error(`Missing '${name}'.`);
  return result;
}

function numberArg(value: unknown, fallback: number) {
  const result = typeof value === "number" ? value : Number(value);
  return Number.isFinite(result) ? result : fallback;
}

function requiredNumber(value: unknown, name: string) {
  const result = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(result)) throw new Error(`Missing '${name}'.`);
  return result;
}

function rpcResult(id: JsonRpcId | undefined, result: unknown) {
  return json({ jsonrpc: "2.0", id: id ?? null, result });
}

function rpcError(id: JsonRpcId | undefined, code: number, message: string) {
  return json({ jsonrpc: "2.0", id: id ?? null, error: { code, message } }, 400);
}

function json(body: unknown, status = 200) {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store" },
  });
}
