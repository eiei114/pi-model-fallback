import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";

export default function registerSmokeProviders(pi) {
  const source = fauxProvider({
    api: "pi-sdk-smoke-faux",
    provider: "pi-sdk-smoke-source",
    models: [{ id: "source", name: "Smoke source", input: ["text"] }],
  });
  const target = fauxProvider({
    api: "pi-sdk-smoke-faux",
    provider: "pi-sdk-smoke-target",
    models: [{ id: "target", name: "Smoke target", input: ["text"] }],
  });

  source.setResponses([fauxAssistantMessage("", {
    stopReason: "error",
    errorMessage: "Error: 429 deterministic smoke failure",
  })]);
  target.setResponses([fauxAssistantMessage("pi-model-fallback-smoke-ok")]);

  pi.registerProvider(source.provider);
  pi.registerProvider(target.provider);
}
