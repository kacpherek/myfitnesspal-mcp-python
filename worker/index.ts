import { Container, getContainer } from "@cloudflare/containers";

interface Env {
  MFP_CONTAINER: DurableObjectNamespace<MyFitnessPalContainer>;
  MFP_USERNAME: string;
  MFP_PASSWORD: string;
  MCP_PATH_TOKEN: string;
}

export class MyFitnessPalContainer extends Container<Env> {
  defaultPort = 8080;
  sleepAfter = "10m";

  constructor(ctx: DurableObjectState<{}>, bindings: Env) {
    super(ctx, bindings);
    this.envVars = {
      MFP_USERNAME: bindings.MFP_USERNAME,
      MFP_PASSWORD: bindings.MFP_PASSWORD,
      MFP_MCP_TRANSPORT: "streamable-http",
      PORT: "8080",
    };
  }
}

export default {
  async fetch(request: Request, bindings: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== `/${bindings.MCP_PATH_TOKEN}`) {
      return new Response("Not found", { status: 404 });
    }

    url.pathname = "/mcp";
    const container = getContainer(bindings.MFP_CONTAINER, "singleton");
    return container.fetch(new Request(url, request));
  },
} satisfies ExportedHandler<Env>;
