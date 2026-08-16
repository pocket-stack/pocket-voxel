import { redirectToHttps } from "../web/https.ts";

export default {
  async fetch(request, env): Promise<Response> {
    const redirect = redirectToHttps(request);
    if (redirect) return redirect;

    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
