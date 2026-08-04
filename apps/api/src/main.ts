import { createApiService } from "./server.js";

const port = Number(process.env.API_PORT ?? 4020);
const host = process.env.API_HOST ?? "127.0.0.1";
const simulatorHttpUrl = process.env.SIMULATOR_HTTP_URL ?? "http://127.0.0.1:4010";
const simulatorWsUrl = process.env.SIMULATOR_WS_URL ?? "ws://127.0.0.1:4010/telemetry";

const service = createApiService({
  simulatorHttpUrl,
  simulatorWsUrl
});

await service.app.listen({ port, host });
