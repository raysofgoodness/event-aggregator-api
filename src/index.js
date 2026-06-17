import { createClient } from "@supabase/supabase-js";
import { bearerAuth } from "hono/bearer-auth";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import { Hono } from "hono";
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;
const app = new Hono();
const parseBody = (body) => {
    if (!body || typeof body !== "object" || Array.isArray(body)) {
        throw new HTTPException(400, { message: "Invalid JSON body" });
    }
    return body;
};
const ensureSite = (site) => {
    if (typeof site !== "string" || site.trim().length === 0) {
        throw new HTTPException(400, { message: "site is required" });
    }
    return site.trim();
};
const parseLimit = (rawLimit) => {
    if (!rawLimit) {
        return DEFAULT_LIMIT;
    }
    const parsed = Number(rawLimit);
    if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new HTTPException(400, {
            message: "limit must be a positive integer",
        });
    }
    return Math.min(parsed, MAX_LIMIT);
};
const parseIsoDate = (value, param) => {
    if (!value) {
        return null;
    }
    const parsed = Date.parse(value);
    if (Number.isNaN(parsed)) {
        throw new HTTPException(400, {
            message: `${param} must be a valid ISO date`,
        });
    }
    return value;
};
app.use("/api/*", async (c, next) => {
    const corsMiddleware = cors({
        origin: c.env.CORS_ORIGIN || "*",
        allowMethods: ["GET", "POST", "OPTIONS"],
        allowHeaders: ["Authorization", "Content-Type"],
    });
    return corsMiddleware(c, next);
});
app.use("/api/*", async (c, next) => {
    return bearerAuth({ token: c.env.API_TOKEN })(c, next);
});
app.post("/api/events", async (c) => {
    let rawBody;
    try {
        rawBody = await c.req.json();
    }
    catch {
        throw new HTTPException(400, { message: "Invalid JSON body" });
    }
    const body = parseBody(rawBody);
    const site = ensureSite(body.site);
    const geoCountry = c.req.raw.cf && typeof c.req.raw.cf.country === "string"
        ? c.req.raw.cf.country
        : null;
    const inputMetadata = body.metadata ?? {};
    const metadata = {
        ...inputMetadata,
        geo: {
            country: geoCountry,
        },
    };
    const supabase = createClient(c.env.SUPABASE_URL, c.env.SUPABASE_KEY, {
        auth: { persistSession: false, autoRefreshToken: false },
    });
    const insertPayload = {
        site,
        session_id: body.session_id,
        visitor_id: body.visitor_id,
        event_type: body.event_type,
        ip: body.ip ?? c.req.header("cf-connecting-ip") ?? null,
        user_agent: body.user_agent ?? c.req.header("user-agent") ?? null,
        url: body.url,
        referrer: body.referrer,
        gclid: body.gclid,
        metadata,
        timestamp: body.timestamp,
    };
    const { data, error } = await supabase
        .from("events")
        .insert(insertPayload)
        .select("id, created_at")
        .single();
    if (error) {
        throw new HTTPException(500, { message: "Database error" });
    }
    return c.json(data, 201);
});
app.get("/api/events", async (c) => {
    const site = c.req.query("site");
    const eventName = c.req.query("event_name");
    const dateFrom = parseIsoDate(c.req.query("date_from"), "date_from");
    const dateTo = parseIsoDate(c.req.query("date_to"), "date_to");
    const limit = parseLimit(c.req.query("limit"));
    const supabase = createClient(c.env.SUPABASE_URL, c.env.SUPABASE_KEY, {
        auth: { persistSession: false, autoRefreshToken: false },
    });
    let query = supabase
        .from("events")
        .select("*", { count: "exact" })
        .order("created_at", { ascending: false })
        .limit(limit);
    if (site) {
        query = query.eq("site", site);
    }
    if (eventName) {
        query = query.eq("event_type", eventName);
    }
    if (dateFrom) {
        query = query.gte("created_at", dateFrom);
    }
    if (dateTo) {
        query = query.lte("created_at", dateTo);
    }
    const { data, error, count } = await query.returns();
    if (error) {
        throw new HTTPException(500, { message: "Database error" });
    }
    return c.json({
        data: data ?? [],
        count: count ?? 0,
    });
});
app.get("/", (c) => c.text("Event Aggregator API"));
app.onError((err, c) => {
    if (err instanceof HTTPException) {
        return err.getResponse();
    }
    console.error("Unhandled internal error:", err);
    return c.json({ error: "Internal Server Error" }, 500);
});
export default app;
