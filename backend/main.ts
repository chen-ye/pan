import { Application, send } from "jsr:@oak/oak";
import { join } from "@std/path";
import { CONFIG } from "./src/config.ts";
import { router } from "./src/router.ts";

console.log("Backend starting...");

const app = new Application();

// Middleware: CORS & Error Handling
app.use(async (ctx, next) => {
  ctx.response.headers.set("Access-Control-Allow-Origin", "*");
  ctx.response.headers.set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  ctx.response.headers.set("Access-Control-Allow-Headers", "Content-Type, Range");
  ctx.response.headers.set("Access-Control-Expose-Headers", "Content-Length, Content-Range");

  if (ctx.request.method === "OPTIONS") {
    ctx.response.status = 204;
    return;
  }

  try {
    await next();
  } catch (err: any) {
    console.error("Server error:", err);
    ctx.response.status = 500;
    ctx.response.body = { error: err.message };
  }
});

// Register routes
app.use(router.routes());
app.use(router.allowedMethods());

// Serve Frontend (Fallback for everything else)
app.use(async (ctx) => {
    const fsRoot = join(Deno.cwd(), "frontend/dist");
    try {
        await send(ctx, ctx.request.url.pathname, {
            root: fsRoot,
            index: "index.html",
        });
    } catch {
        // Fallback to index.html for SPA
        await send(ctx, "index.html", {
            root: fsRoot,
        });
    }
});

console.log("Starting server setup...");
console.log(`Server running on http://0.0.0.0:${CONFIG.PORT}`);

await app.listen({ port: CONFIG.PORT });
