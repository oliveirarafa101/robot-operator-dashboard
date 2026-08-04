import { createSimulatorService } from "./server.js";

const port = Number(process.env.SIMULATOR_PORT ?? 4010);
const host = process.env.SIMULATOR_HOST ?? "127.0.0.1";
const service = createSimulatorService();

await service.app.listen({ port, host });
