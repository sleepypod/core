module.exports = [
"[externals]/react/jsx-dev-runtime [external] (react/jsx-dev-runtime, cjs)", ((__turbopack_context__, module, exports) => {

const mod = __turbopack_context__.x("react/jsx-dev-runtime", () => require("react/jsx-dev-runtime"));

module.exports = mod;
}),
"[externals]/@trpc/client [external] (@trpc/client, esm_import)", ((__turbopack_context__) => {
"use strict";

return __turbopack_context__.a(async (__turbopack_handle_async_dependencies__, __turbopack_async_result__) => { try {

const mod = await __turbopack_context__.y("@trpc/client");

__turbopack_context__.n(mod);
__turbopack_async_result__();
} catch(e) { __turbopack_async_result__(e); } }, true);}),
"[externals]/@trpc/next [external] (@trpc/next, esm_import)", ((__turbopack_context__) => {
"use strict";

return __turbopack_context__.a(async (__turbopack_handle_async_dependencies__, __turbopack_async_result__) => { try {

const mod = await __turbopack_context__.y("@trpc/next");

__turbopack_context__.n(mod);
__turbopack_async_result__();
} catch(e) { __turbopack_async_result__(e); } }, true);}),
"[externals]/@trpc/next/ssrPrepass [external] (@trpc/next/ssrPrepass, esm_import)", ((__turbopack_context__) => {
"use strict";

return __turbopack_context__.a(async (__turbopack_handle_async_dependencies__, __turbopack_async_result__) => { try {

const mod = await __turbopack_context__.y("@trpc/next/ssrPrepass");

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
"[project]/src/utils/transformer.ts [ssr] (ecmascript)", ((__turbopack_context__) => {
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
"[project]/src/utils/trpc.ts [ssr] (ecmascript)", ((__turbopack_context__) => {
"use strict";

return __turbopack_context__.a(async (__turbopack_handle_async_dependencies__, __turbopack_async_result__) => { try {

__turbopack_context__.s([
    "trpc",
    ()=>trpc
]);
var __TURBOPACK__imported__module__$5b$externals$5d2f40$trpc$2f$client__$5b$external$5d$__$2840$trpc$2f$client$2c$__esm_import$29$__ = __turbopack_context__.i("[externals]/@trpc/client [external] (@trpc/client, esm_import)");
var __TURBOPACK__imported__module__$5b$externals$5d2f40$trpc$2f$next__$5b$external$5d$__$2840$trpc$2f$next$2c$__esm_import$29$__ = __turbopack_context__.i("[externals]/@trpc/next [external] (@trpc/next, esm_import)");
var __TURBOPACK__imported__module__$5b$externals$5d2f40$trpc$2f$next$2f$ssrPrepass__$5b$external$5d$__$2840$trpc$2f$next$2f$ssrPrepass$2c$__esm_import$29$__ = __turbopack_context__.i("[externals]/@trpc/next/ssrPrepass [external] (@trpc/next/ssrPrepass, esm_import)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$utils$2f$transformer$2e$ts__$5b$ssr$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/utils/transformer.ts [ssr] (ecmascript)");
var __turbopack_async_dependencies__ = __turbopack_handle_async_dependencies__([
    __TURBOPACK__imported__module__$5b$externals$5d2f40$trpc$2f$client__$5b$external$5d$__$2840$trpc$2f$client$2c$__esm_import$29$__,
    __TURBOPACK__imported__module__$5b$externals$5d2f40$trpc$2f$next__$5b$external$5d$__$2840$trpc$2f$next$2c$__esm_import$29$__,
    __TURBOPACK__imported__module__$5b$externals$5d2f40$trpc$2f$next$2f$ssrPrepass__$5b$external$5d$__$2840$trpc$2f$next$2f$ssrPrepass$2c$__esm_import$29$__,
    __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$utils$2f$transformer$2e$ts__$5b$ssr$5d$__$28$ecmascript$29$__
]);
[__TURBOPACK__imported__module__$5b$externals$5d2f40$trpc$2f$client__$5b$external$5d$__$2840$trpc$2f$client$2c$__esm_import$29$__, __TURBOPACK__imported__module__$5b$externals$5d2f40$trpc$2f$next__$5b$external$5d$__$2840$trpc$2f$next$2c$__esm_import$29$__, __TURBOPACK__imported__module__$5b$externals$5d2f40$trpc$2f$next$2f$ssrPrepass__$5b$external$5d$__$2840$trpc$2f$next$2f$ssrPrepass$2c$__esm_import$29$__, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$utils$2f$transformer$2e$ts__$5b$ssr$5d$__$28$ecmascript$29$__] = __turbopack_async_dependencies__.then ? (await __turbopack_async_dependencies__)() : __turbopack_async_dependencies__;
;
;
;
;
function getBaseUrl() {
    if ("TURBOPACK compile-time falsy", 0) //TURBOPACK unreachable
    ;
    // When rendering on the server, we return an absolute URL
    // reference for vercel.com
    if (process.env.VERCEL_URL) {
        return `https://${process.env.VERCEL_URL}`;
    }
    // assume localhost
    return `http://localhost:${process.env.PORT ?? 3000}`;
}
const trpc = (0, __TURBOPACK__imported__module__$5b$externals$5d2f40$trpc$2f$next__$5b$external$5d$__$2840$trpc$2f$next$2c$__esm_import$29$__["createTRPCNext"])({
    config () {
        const url = getBaseUrl() + '/api/trpc';
        return {
            links: [
                (0, __TURBOPACK__imported__module__$5b$externals$5d2f40$trpc$2f$client__$5b$external$5d$__$2840$trpc$2f$client$2c$__esm_import$29$__["splitLink"])({
                    condition: (op)=>op.type === 'subscription',
                    true: (0, __TURBOPACK__imported__module__$5b$externals$5d2f40$trpc$2f$client__$5b$external$5d$__$2840$trpc$2f$client$2c$__esm_import$29$__["httpSubscriptionLink"])({
                        url,
                        transformer: __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$utils$2f$transformer$2e$ts__$5b$ssr$5d$__$28$ecmascript$29$__["transformer"]
                    }),
                    false: (0, __TURBOPACK__imported__module__$5b$externals$5d2f40$trpc$2f$client__$5b$external$5d$__$2840$trpc$2f$client$2c$__esm_import$29$__["httpBatchLink"])({
                        url,
                        transformer: __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$utils$2f$transformer$2e$ts__$5b$ssr$5d$__$28$ecmascript$29$__["transformer"]
                    })
                })
            ]
        };
    },
    ssr: true,
    ssrPrepass: __TURBOPACK__imported__module__$5b$externals$5d2f40$trpc$2f$next$2f$ssrPrepass__$5b$external$5d$__$2840$trpc$2f$next$2f$ssrPrepass$2c$__esm_import$29$__["ssrPrepass"],
    transformer: __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$utils$2f$transformer$2e$ts__$5b$ssr$5d$__$28$ecmascript$29$__["transformer"]
});
__turbopack_async_result__();
} catch(e) { __turbopack_async_result__(e); } }, false);}),
"[project]/src/pages/_app.tsx [ssr] (ecmascript)", ((__turbopack_context__) => {
"use strict";

return __turbopack_context__.a(async (__turbopack_handle_async_dependencies__, __turbopack_async_result__) => { try {

__turbopack_context__.s([
    "default",
    ()=>__TURBOPACK__default__export__
]);
var __TURBOPACK__imported__module__$5b$externals$5d2f$react$2f$jsx$2d$dev$2d$runtime__$5b$external$5d$__$28$react$2f$jsx$2d$dev$2d$runtime$2c$__cjs$29$__ = __turbopack_context__.i("[externals]/react/jsx-dev-runtime [external] (react/jsx-dev-runtime, cjs)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$utils$2f$trpc$2e$ts__$5b$ssr$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/utils/trpc.ts [ssr] (ecmascript)");
var __turbopack_async_dependencies__ = __turbopack_handle_async_dependencies__([
    __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$utils$2f$trpc$2e$ts__$5b$ssr$5d$__$28$ecmascript$29$__
]);
[__TURBOPACK__imported__module__$5b$project$5d2f$src$2f$utils$2f$trpc$2e$ts__$5b$ssr$5d$__$28$ecmascript$29$__] = __turbopack_async_dependencies__.then ? (await __turbopack_async_dependencies__)() : __turbopack_async_dependencies__;
;
;
const MyApp = ({ Component, pageProps })=>{
    return /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$externals$5d2f$react$2f$jsx$2d$dev$2d$runtime__$5b$external$5d$__$28$react$2f$jsx$2d$dev$2d$runtime$2c$__cjs$29$__["jsxDEV"])(Component, {
        ...pageProps
    }, void 0, false, {
        fileName: "[project]/src/pages/_app.tsx",
        lineNumber: 5,
        columnNumber: 10
    }, ("TURBOPACK compile-time value", void 0));
};
const __TURBOPACK__default__export__ = __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$utils$2f$trpc$2e$ts__$5b$ssr$5d$__$28$ecmascript$29$__["trpc"].withTRPC(MyApp);
__turbopack_async_result__();
} catch(e) { __turbopack_async_result__(e); } }, false);}),
];

//# sourceMappingURL=%5Broot-of-the-server%5D__c133010c._.js.map