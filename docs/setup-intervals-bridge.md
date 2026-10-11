# Free automatic updates with intervals.icu + the GT2 Bridge

[intervals.icu](https://intervals.icu) connects natively to Huawei Health and receives new activities (with GPS and heart rate) and daily wellness (steps, sleep, resting HR). It has a free personal API key. The dashboard cannot call outside websites, so a tiny Cloudflare Worker, the **GT2 Bridge** in `bridge/`, exposes that API as a private claude.ai connector. Everything stays on free tiers.

```
Watch → Huawei Health → intervals.icu → GT2 Bridge (your Cloudflare Worker) → claude.ai connector → dashboard
```

## 1. intervals.icu

1. Create a free account at intervals.icu.
2. **Settings → Connections → HUAWEI Health**. Connect, then allow the link in Huawei Health under its third-party services (Health Service Kit). Huawei lets intervals.icu backfill up to one year.
3. **Settings → Developer settings**: copy your **API key**.

## 2. Deploy the bridge (Cloudflare, free)

1. In the Cloudflare dashboard, create the KV namespace the OAuth library needs (or ask Claude to create it with the Cloudflare connector):
   - Go to **Storage & databases → KV → Create**, named `gt2-bridge-oauth`.
   - Put its id into `bridge/wrangler.jsonc` (`REPLACE_WITH_KV_NAMESPACE_ID`).
2. Go to **Workers & Pages → Create → Import a repository**:
   - pick this GitHub repository;
   - set **Root directory** to `bridge`;
   - deploy.

   Every push to the main branch redeploys it.
3. In the Worker's **Settings → Variables and secrets**, add two **secrets**:
   - `INTERVALS_API_KEY`: the key from intervals.icu.
   - `BRIDGE_PASSPHRASE`: a long random phrase. You type it once, when connecting.
4. Open `https://gt2-bridge.<your-subdomain>.workers.dev/` to check that it answers.

## 3. Add it to claude.ai

1. Go to **Settings → Connectors → Add custom connector**.
2. Name it exactly **GT2 Bridge**, with URL `https://gt2-bridge.<your-subdomain>.workers.dev/mcp`.
3. Click **Connect**: the bridge's page asks for your passphrase → **Allow**.
4. Enable the connector in the chat where you work on the dashboard, and tell Claude it's done.

Claude then:
- calls `list_activities` and `get_wellness` once to confirm that intervals.icu shares your Huawei data through its API;
- finishes the sync code;
- republishes the dashboard with the connector declared.

## What the bridge exposes

All tools are read-only:

| Tool | Returns |
|---|---|
| `list_activities {oldest, newest, limit?}` | Activities with distance, times, elevation, HR, speed, cadence, calories |
| `get_activity_streams {id, max_points?}` | Downsampled time, lat/lng, HR, altitude, speed, cadence, distance |
| `get_wellness {oldest, newest}` | Daily steps, sleep, resting HR, HRV, SpO2, weight |

## Security

- **Access:** the bridge only answers OAuth tokens issued after your passphrase.
- **Secrets:** your intervals.icu key lives only in the Worker's secrets. Tokens are stored hashed in your KV namespace.
- **Revoking access:** remove the connector in claude.ai, or rotate `BRIDGE_PASSPHRASE` and `INTERVALS_API_KEY`.

## Develop

```sh
cd bridge
npm install
npm test            # protocol and API client tests with a mocked fetch
npx wrangler dev    # local run (needs .dev.vars with the two secrets)
```
