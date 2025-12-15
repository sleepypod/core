module.exports = [
"[externals]/next/dist/compiled/@opentelemetry/api [external] (next/dist/compiled/@opentelemetry/api, cjs)", ((__turbopack_context__, module, exports) => {

const mod = __turbopack_context__.x("next/dist/compiled/@opentelemetry/api", () => require("next/dist/compiled/@opentelemetry/api"));

module.exports = mod;
}),
"[externals]/next/dist/compiled/next-server/pages-api-turbo.runtime.dev.js [external] (next/dist/compiled/next-server/pages-api-turbo.runtime.dev.js, cjs)", ((__turbopack_context__, module, exports) => {

const mod = __turbopack_context__.x("next/dist/compiled/next-server/pages-api-turbo.runtime.dev.js", () => require("next/dist/compiled/next-server/pages-api-turbo.runtime.dev.js"));

module.exports = mod;
}),
"[externals]/@trpc/server [external] (@trpc/server, esm_import)", ((__turbopack_context__) => {
"use strict";

return __turbopack_context__.a(async (__turbopack_handle_async_dependencies__, __turbopack_async_result__) => { try {

const mod = await __turbopack_context__.y("@trpc/server");

__turbopack_context__.n(mod);
__turbopack_async_result__();
} catch(e) { __turbopack_async_result__(e); } }, true);}),
"[externals]/@trpc/server/adapters/next [external] (@trpc/server/adapters/next, esm_import)", ((__turbopack_context__) => {
"use strict";

return __turbopack_context__.a(async (__turbopack_handle_async_dependencies__, __turbopack_async_result__) => { try {

const mod = await __turbopack_context__.y("@trpc/server/adapters/next");

__turbopack_context__.n(mod);
__turbopack_async_result__();
} catch(e) { __turbopack_async_result__(e); } }, true);}),
"[externals]/zod [external] (zod, esm_import)", ((__turbopack_context__) => {
"use strict";

return __turbopack_context__.a(async (__turbopack_handle_async_dependencies__, __turbopack_async_result__) => { try {

const mod = await __turbopack_context__.y("zod");

__turbopack_context__.n(mod);
__turbopack_async_result__();
} catch(e) { __turbopack_async_result__(e); } }, true);}),
"[externals]/superjson [external] (superjson, esm_import)", ((__turbopack_context__) => {
"use strict";

return __turbopack_context__.a(async (__turbopack_handle_async_dependencies__, __turbopack_async_result__) => { try {

const mod = await __turbopack_context__.y("superjson");

__turbopack_context__.n(mod);
__turbopack_async_result__();
} catch(e) { __turbopack_async_result__(e); } }, true);}),
"[project]/src/utils/transformer.ts [api] (ecmascript)", ((__turbopack_context__) => {
"use strict";

return __turbopack_context__.a(async (__turbopack_handle_async_dependencies__, __turbopack_async_result__) => { try {

/**
 * If you need to add transformers for special data types like `Temporal.Instant` or `Temporal.Date`, `Decimal.js`, etc you can do so here.
 * Make sure to import this file rather than `superjson` directly.
 * @see https://github.com/blitz-js/superjson#recipes
 */ __turbopack_context__.s([
    "transformer",
    ()=>transformer
]);
var __TURBOPACK__imported__module__$5b$externals$5d2f$superjson__$5b$external$5d$__$28$superjson$2c$__esm_import$29$__ = __turbopack_context__.i("[externals]/superjson [external] (superjson, esm_import)");
var __turbopack_async_dependencies__ = __turbopack_handle_async_dependencies__([
    __TURBOPACK__imported__module__$5b$externals$5d2f$superjson__$5b$external$5d$__$28$superjson$2c$__esm_import$29$__
]);
[__TURBOPACK__imported__module__$5b$externals$5d2f$superjson__$5b$external$5d$__$28$superjson$2c$__esm_import$29$__] = __turbopack_async_dependencies__.then ? (await __turbopack_async_dependencies__)() : __turbopack_async_dependencies__;
;
const transformer = __TURBOPACK__imported__module__$5b$externals$5d2f$superjson__$5b$external$5d$__$28$superjson$2c$__esm_import$29$__["default"];
__turbopack_async_result__();
} catch(e) { __turbopack_async_result__(e); } }, false);}),
"[project]/src/server/trpc.ts [api] (ecmascript)", ((__turbopack_context__) => {
"use strict";

return __turbopack_context__.a(async (__turbopack_handle_async_dependencies__, __turbopack_async_result__) => { try {

/**
 * This is your entry point to setup the root configuration for tRPC on the server.
 * - `initTRPC` should only be used once per app.
 * - We export only the functionality that we use so we can enforce which base procedures should be used
 *
 * Learn how to create protected base procedures and other things below:
 * @see https://trpc.io/docs/v11/router
 * @see https://trpc.io/docs/v11/procedures
 */ __turbopack_context__.s([
    "publicProcedure",
    ()=>publicProcedure,
    "router",
    ()=>router
]);
var __TURBOPACK__imported__module__$5b$externals$5d2f40$trpc$2f$server__$5b$external$5d$__$2840$trpc$2f$server$2c$__esm_import$29$__ = __turbopack_context__.i("[externals]/@trpc/server [external] (@trpc/server, esm_import)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$utils$2f$transformer$2e$ts__$5b$api$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/utils/transformer.ts [api] (ecmascript)");
var __turbopack_async_dependencies__ = __turbopack_handle_async_dependencies__([
    __TURBOPACK__imported__module__$5b$externals$5d2f40$trpc$2f$server__$5b$external$5d$__$2840$trpc$2f$server$2c$__esm_import$29$__,
    __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$utils$2f$transformer$2e$ts__$5b$api$5d$__$28$ecmascript$29$__
]);
[__TURBOPACK__imported__module__$5b$externals$5d2f40$trpc$2f$server__$5b$external$5d$__$2840$trpc$2f$server$2c$__esm_import$29$__, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$utils$2f$transformer$2e$ts__$5b$api$5d$__$28$ecmascript$29$__] = __turbopack_async_dependencies__.then ? (await __turbopack_async_dependencies__)() : __turbopack_async_dependencies__;
;
;
const t = __TURBOPACK__imported__module__$5b$externals$5d2f40$trpc$2f$server__$5b$external$5d$__$2840$trpc$2f$server$2c$__esm_import$29$__["initTRPC"].create({
    transformer: __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$utils$2f$transformer$2e$ts__$5b$api$5d$__$28$ecmascript$29$__["transformer"]
});
const publicProcedure = t.procedure;
const router = t.router;
__turbopack_async_result__();
} catch(e) { __turbopack_async_result__(e); } }, false);}),
"[project]/src/pages/api/trpc/[trpc].ts [api] (ecmascript)", ((__turbopack_context__) => {
"use strict";

return __turbopack_context__.a(async (__turbopack_handle_async_dependencies__, __turbopack_async_result__) => { try {

/**
 * This is the API-handler of your app that contains all your API routes.
 * On a bigger app, you will probably want to split this file up into multiple files.
 */ __turbopack_context__.s([
    "default",
    ()=>__TURBOPACK__default__export__
]);
var __TURBOPACK__imported__module__$5b$externals$5d2f40$trpc$2f$server__$5b$external$5d$__$2840$trpc$2f$server$2c$__esm_import$29$__ = __turbopack_context__.i("[externals]/@trpc/server [external] (@trpc/server, esm_import)");
var __TURBOPACK__imported__module__$5b$externals$5d2f40$trpc$2f$server$2f$adapters$2f$next__$5b$external$5d$__$2840$trpc$2f$server$2f$adapters$2f$next$2c$__esm_import$29$__ = __turbopack_context__.i("[externals]/@trpc/server/adapters/next [external] (@trpc/server/adapters/next, esm_import)");
var __TURBOPACK__imported__module__$5b$externals$5d2f$zod__$5b$external$5d$__$28$zod$2c$__esm_import$29$__ = __turbopack_context__.i("[externals]/zod [external] (zod, esm_import)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$server$2f$trpc$2e$ts__$5b$api$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/server/trpc.ts [api] (ecmascript)");
var __turbopack_async_dependencies__ = __turbopack_handle_async_dependencies__([
    __TURBOPACK__imported__module__$5b$externals$5d2f40$trpc$2f$server__$5b$external$5d$__$2840$trpc$2f$server$2c$__esm_import$29$__,
    __TURBOPACK__imported__module__$5b$externals$5d2f40$trpc$2f$server$2f$adapters$2f$next__$5b$external$5d$__$2840$trpc$2f$server$2f$adapters$2f$next$2c$__esm_import$29$__,
    __TURBOPACK__imported__module__$5b$externals$5d2f$zod__$5b$external$5d$__$28$zod$2c$__esm_import$29$__,
    __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$server$2f$trpc$2e$ts__$5b$api$5d$__$28$ecmascript$29$__
]);
[__TURBOPACK__imported__module__$5b$externals$5d2f40$trpc$2f$server__$5b$external$5d$__$2840$trpc$2f$server$2c$__esm_import$29$__, __TURBOPACK__imported__module__$5b$externals$5d2f40$trpc$2f$server$2f$adapters$2f$next__$5b$external$5d$__$2840$trpc$2f$server$2f$adapters$2f$next$2c$__esm_import$29$__, __TURBOPACK__imported__module__$5b$externals$5d2f$zod__$5b$external$5d$__$28$zod$2c$__esm_import$29$__, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$server$2f$trpc$2e$ts__$5b$api$5d$__$28$ecmascript$29$__] = __turbopack_async_dependencies__.then ? (await __turbopack_async_dependencies__)() : __turbopack_async_dependencies__;
;
;
;
;
let subscriptionIdx = 0;
const appRouter = (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$server$2f$trpc$2e$ts__$5b$api$5d$__$28$ecmascript$29$__["router"])({
    greeting: __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$server$2f$trpc$2e$ts__$5b$api$5d$__$28$ecmascript$29$__["publicProcedure"]// This is the input schema of your procedure
    // 💡 Tip: Try changing this and see type errors on the client straight away
    .input(__TURBOPACK__imported__module__$5b$externals$5d2f$zod__$5b$external$5d$__$28$zod$2c$__esm_import$29$__["z"].object({
        name: __TURBOPACK__imported__module__$5b$externals$5d2f$zod__$5b$external$5d$__$28$zod$2c$__esm_import$29$__["z"].string().nullish()
    })).query(({ input })=>{
        // This is what you're returning to your client
        return {
            text: `hello ${input?.name ?? 'world'}`
        };
    }),
    loopData: __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$server$2f$trpc$2e$ts__$5b$api$5d$__$28$ecmascript$29$__["publicProcedure"].input(__TURBOPACK__imported__module__$5b$externals$5d2f$zod__$5b$external$5d$__$28$zod$2c$__esm_import$29$__["z"].object({
        lastEventId: __TURBOPACK__imported__module__$5b$externals$5d2f$zod__$5b$external$5d$__$28$zod$2c$__esm_import$29$__["z"].coerce.number().finite().nonnegative()
    }).optional()).subscription(async function*(opts) {
        const id = ++subscriptionIdx;
        let count = opts.input?.lastEventId ?? 0;
        console.log(`[${id}] 🚀 Starting subscription id: ${id} - lastEventId: ${count}`);
        try {
            while(!opts.signal?.aborted){
                ++count;
                console.log(`[${id}] 🔄 loop ${count}`);
                yield (0, __TURBOPACK__imported__module__$5b$externals$5d2f40$trpc$2f$server__$5b$external$5d$__$2840$trpc$2f$server$2c$__esm_import$29$__["tracked"])(`${count}`, `[${id}] 📬 new data (count: ${count}, sub id: ${id})`);
                await new Promise((resolve)=>setTimeout(resolve, 1000));
            }
            console.log(`[${id}] ✅ done`);
        } catch (error) {
            console.error(`[${id}] ❌ error`, error);
        }
    })
});
const __TURBOPACK__default__export__ = __TURBOPACK__imported__module__$5b$externals$5d2f40$trpc$2f$server$2f$adapters$2f$next__$5b$external$5d$__$2840$trpc$2f$server$2f$adapters$2f$next$2c$__esm_import$29$__["createNextApiHandler"]({
    router: appRouter,
    createContext: ()=>({})
});
__turbopack_async_result__();
} catch(e) { __turbopack_async_result__(e); } }, false);}),
];

//# sourceMappingURL=%5Broot-of-the-server%5D__c818b5df._.js.map