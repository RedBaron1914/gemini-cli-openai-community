import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { Env } from "./types";
import app from "./index";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Node.js Server for Gemini CLI OpenAI Proxy
 * 
 * This allows running the proxy on a standard Linux server,
 * helping bypass potential IP-based restrictions on Cloudflare Workers.
 */

// Simple file-based mock for Cloudflare KV storage
const CACHE_FILE = path.join(process.cwd(), ".cache_tokens.json");

const kvMock = {
    get: async (key: string, type: string) => {
        if (!fs.existsSync(CACHE_FILE)) return null;
        const data = JSON.parse(fs.readFileSync(CACHE_FILE, "utf-8"));
        const entry = data[key];
        if (!entry) return null;
        
        // Check TTL
        if (entry.expiry && entry.expiry < Date.now()) {
            delete data[key];
            fs.writeFileSync(CACHE_FILE, JSON.stringify(data));
            return null;
        }
        
        return type === "json" ? entry.value : JSON.stringify(entry.value);
    },
    put: async (key: string, value: string, options?: { expirationTtl?: number }) => {
        const data = fs.existsSync(CACHE_FILE) ? JSON.parse(fs.readFileSync(CACHE_FILE, "utf-8")) : {};
        data[key] = {
            value: JSON.parse(value),
            expiry: options?.expirationTtl ? Date.now() + (options.expirationTtl * 1000) : null
        };
        fs.writeFileSync(CACHE_FILE, JSON.stringify(data, null, 2));
    },
    delete: async (key: string) => {
        if (!fs.existsSync(CACHE_FILE)) return;
        const data = JSON.parse(fs.readFileSync(CACHE_FILE, "utf-8"));
        delete data[key];
        fs.writeFileSync(CACHE_FILE, JSON.stringify(data));
    }
};

// Map environment variables from process.env to Hono context
const nodeApp = new Hono<{ Bindings: Env }>();

nodeApp.use("*", async (c, next) => {
    // Inject mock KV and environment variables
    c.env = {
        ...process.env,
        GEMINI_CLI_KV: kvMock as any,
    } as any;
    await next();
});

nodeApp.route("/", app);

const port = process.env.PORT ? parseInt(process.env.PORT) : 3000;
console.log(`Server is running on port ${port}`);

serve({
    fetch: nodeApp.fetch,
    port
});
