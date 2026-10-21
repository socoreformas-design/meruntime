import { rotateApiToken } from "../../http-api/src/token.js";

export function runToken(args: string[]): number {
    if (args.length !== 1 || args[0] !== "rotate") {
        console.error("Usage: meruntime token rotate");
        return 1;
    }
    try {
        rotateApiToken();
        console.log("API token rotated. The new token is active immediately.");
        return 0;
    } catch (error) {
        console.error(error instanceof Error ? error.message : "Could not rotate the API token.");
        return 1;
    }
}