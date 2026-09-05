import { createApplication } from "./app/application.js";

const application = createApplication();

export async function startMidimasterApp() {
  await application.start();
}
