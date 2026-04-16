import { createApp } from "./app";
import { env } from "./lib/env";

const app = createApp();

app.listen(env.apiPort, "0.0.0.0", () => {
  console.log(`API listening on http://0.0.0.0:${env.apiPort}`);
});
