import { startProtectedResourceServer } from "./protectedResource.js";
import { readProtectedToken } from "./secrets.js";

try {
    const server = await startProtectedResourceServer({ expectedToken: readProtectedToken(), port: 9876 });
    console.log("MERUNTIME_PROTECTED_SERVE listening on http://127.0.0.1:9876/mark");

    const stop = async () => {
        await server.close();
        process.exit(0);
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
} catch (error) {
    console.error(`MERUNTIME_PROTECTED_SERVE_ERROR ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
}
