// Uso: npm run fakebank  (127.0.0.1:4318). El token sale de ~/.meruntime/secrets.json (fakeBankToken).

import { readFakeBankToken } from "../../engine/src/secrets.js";
import { startFakeBank } from "./server.js";

const bank = await startFakeBank({ token: readFakeBankToken() });
console.log(`fakebank escuchando en ${bank.url} (POST /transfers, GET /transfers)`);
