import { createApp } from "./app";
import { env } from "./lib/env";

const app = createApp();

app.listen(env.apiPort, () => {
  console.log(`API listening on http://localhost:${env.apiPort}`);
});
