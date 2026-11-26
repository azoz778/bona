# Website and concierge regression baseline

Run the focused local baseline with one command:

```bash
npm run test:regression
```

The command builds the static site, then checks:

- the main English (`/`) and Arabic (`/ar/`) output, including `lang`, direction, and Dana's localized server-rendered mount config;
- Dana's initialization boundary across Astro page load, page swap, missing-mount, and page-hide events;
- one synthetic Arabic listing-intake fixture through the local brochure classifier and caption parser.

The lifecycle test uses an in-memory mount and a mocked controller (`bind`, `unbind`, and `dispose`). The intake fixture is synthetic and stops before AI, WhatsApp, GitHub publishing, or any other network boundary. The command needs no production credentials or customer data.
