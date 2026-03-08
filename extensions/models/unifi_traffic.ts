import { z } from "npm:zod@4";

const CLOUD_API_BASE = "https://api.ui.com";

const GlobalArgsSchema = z.object({
  mode: z.enum(["local", "cloud"]).default("local").describe(
    "Connection mode: 'local' for direct UDM access, 'cloud' for remote via api.ui.com",
  ),
  host: z.string().optional().describe(
    "UDM IP address or hostname (required for local mode, e.g. 192.168.1.1)",
  ),
  username: z.string().optional().describe(
    "Local admin username (required for local mode)",
  ),
  password: z.string().meta({ sensitive: true }).optional().describe(
    "Local admin password (required for local mode)",
  ),
  site: z.string().default("default").describe("UniFi site name"),
  apiKey: z.string().meta({ sensitive: true }).optional().describe(
    "UniFi Cloud API key (required for cloud mode)",
  ),
});

const HourlyTrafficSchema = z.object({
  time: z.number(),
  bytes: z.number().optional(),
  wanTxBytes: z.number().optional(),
  wanRxBytes: z.number().optional(),
  wlanBytes: z.number().optional(),
  numSta: z.number().optional(),
  lanNumSta: z.number().optional(),
  wlanNumSta: z.number().optional(),
});

const SiteTrafficSchema = z.object({
  collectedAt: z.string(),
  periodStart: z.string(),
  periodEnd: z.string(),
  hourly: z.array(HourlyTrafficSchema),
  totalBytes: z.number(),
  totalWanTx: z.number(),
  totalWanRx: z.number(),
  totalWlanBytes: z.number(),
  peakHour: z.object({
    time: z.string(),
    bytes: z.number(),
  }),
  averageClients: z.number(),
});

const ClientSchema = z.object({
  mac: z.string(),
  ip: z.string().optional(),
  hostname: z.string().optional(),
  name: z.string().optional(),
  rxBytes: z.number(),
  txBytes: z.number(),
  totalBytes: z.number(),
  bytesRate: z.number().optional(),
  isWired: z.boolean(),
  essid: z.string().optional(),
  network: z.string().optional(),
  signal: z.number().optional(),
  uptime: z.number().optional(),
});

const ClientTrafficSchema = z.object({
  collectedAt: z.string(),
  clientCount: z.number(),
  wiredCount: z.number(),
  wirelessCount: z.number(),
  clients: z.array(ClientSchema),
  topClientsByUsage: z.array(z.object({
    name: z.string(),
    totalBytes: z.number(),
    percentage: z.number(),
  })),
});

const DpiCategorySchema = z.object({
  category: z.string(),
  categoryCode: z.number(),
  rxBytes: z.number(),
  txBytes: z.number(),
  totalBytes: z.number(),
});

const DpiStatsSchema = z.object({
  collectedAt: z.string(),
  categories: z.array(DpiCategorySchema),
  topCategories: z.array(z.object({
    category: z.string(),
    totalBytes: z.number(),
    percentage: z.number(),
  })),
});

const DPI_CATEGORIES: Record<number, string> = {
  0: "Instant Messaging",
  1: "P2P",
  2: "Audio",
  3: "File Transfer",
  4: "Streaming Media",
  5: "Mail",
  6: "VoIP",
  7: "Database",
  8: "Games",
  9: "Network Management",
  10: "Remote Access",
  13: "Web",
  14: "Security",
  18: "E-Commerce",
  20: "Social Network",
  23: "Productivity",
  255: "Unknown",
};

interface ApiClient {
  request(
    path: string,
    method?: string,
    body?: unknown,
  ): Promise<Record<string, unknown>>;
  cleanup(): Promise<void>;
}

async function createLocalClient(
  host: string,
  username: string,
  password: string,
): Promise<ApiClient> {
  const baseUrl = `https://${host}`;

  // UDM uses a self-signed certificate - use Deno.Command to call curl
  // since Deno's fetch cannot skip TLS verification without a CLI flag
  async function localFetch(
    url: string,
    init?: RequestInit,
  ): Promise<Response> {
    const args = [
      "-sk",
      "--connect-timeout",
      "10",
      "-X",
      init?.method || "GET",
    ];

    if (init?.headers) {
      const headers = init.headers as Record<string, string>;
      for (const [key, value] of Object.entries(headers)) {
        args.push("-H", `${key}: ${value}`);
      }
    }

    if (init?.body) {
      args.push("-d", init.body as string);
    }

    // Capture response headers too
    args.push("-D", "/dev/stderr");
    args.push(url);

    const cmd = new Deno.Command("curl", {
      args,
      stdout: "piped",
      stderr: "piped",
    });

    const output = await cmd.output();
    const body = new TextDecoder().decode(output.stdout);
    const headerText = new TextDecoder().decode(output.stderr);

    // Parse status code from header line
    const statusMatch = headerText.match(/HTTP\/[\d.]+ (\d+)/);
    const status = statusMatch
      ? parseInt(statusMatch[1])
      : (output.success ? 200 : 500);

    // Parse headers
    const responseHeaders = new Headers();
    for (const line of headerText.split("\r\n")) {
      const colonIdx = line.indexOf(":");
      if (colonIdx > 0) {
        responseHeaders.append(
          line.slice(0, colonIdx).trim(),
          line.slice(colonIdx + 1).trim(),
        );
      }
    }

    return new Response(body, { status, headers: responseHeaders });
  }

  const loginResp = await localFetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ username, password, remember: true }),
  });

  if (!loginResp.ok) {
    const text = await loginResp.text();
    throw new Error(`UniFi login failed (${loginResp.status}): ${text}`);
  }

  const csrfToken = loginResp.headers.get("x-csrf-token") || "";
  const setCookie = loginResp.headers.get("set-cookie") || "";
  const cookie = setCookie.split(",").map((c) => c.split(";")[0].trim()).join(
    "; ",
  );

  return {
    async request(path, method = "GET", body?) {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        Accept: "application/json",
        Cookie: cookie,
      };
      if (method === "POST") {
        headers["X-CSRF-Token"] = csrfToken;
      }

      const resp = await localFetch(`${baseUrl}${path}`, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
      });

      if (!resp.ok) {
        const text = await resp.text();
        throw new Error(
          `UniFi API ${method} ${path} failed (${resp.status}): ${text}`,
        );
      }

      return await resp.json();
    },
    async cleanup() {
      try {
        await localFetch(`${baseUrl}/api/auth/logout`, {
          method: "POST",
          headers: { Cookie: cookie, "X-CSRF-Token": csrfToken },
        });
      } catch {
        // best-effort logout
      }
    },
  };
}

interface CloudClient {
  client: ApiClient;
  siteName: string;
  hostId: string;
  rawRequest: (
    fullPath: string,
    method?: string,
    body?: unknown,
  ) => Promise<Record<string, unknown>>;
}

async function createCloudClient(
  apiKey: string,
  site: string,
): Promise<CloudClient> {
  const headers = {
    "X-API-KEY": apiKey,
    Accept: "application/json",
    "Content-Type": "application/json",
  };

  // Discover host
  const hostsResp = await fetch(`${CLOUD_API_BASE}/v1/hosts`, { headers });
  if (!hostsResp.ok) {
    throw new Error(`Failed to list hosts (${hostsResp.status})`);
  }
  const hostsData = await hostsResp.json();
  const hosts = hostsData.data || [];
  if (hosts.length === 0) {
    throw new Error("No UniFi hosts found for this API key");
  }
  const hostId = hosts[0].id;

  // Discover site
  const sitesResp = await fetch(`${CLOUD_API_BASE}/v1/sites`, { headers });
  if (!sitesResp.ok) {
    throw new Error(`Failed to list sites (${sitesResp.status})`);
  }
  const sitesData = await sitesResp.json();
  const sites = sitesData.data || [];
  if (sites.length === 0) {
    throw new Error("No UniFi sites found for this API key");
  }
  const resolvedSite = sites[0];
  const siteName = resolvedSite.meta?.name || site;

  const connectorBase =
    `/v1/connector/consoles/${hostId}/proxy/network/api/s/${siteName}`;

  async function rawRequest(
    fullPath: string,
    method = "GET",
    body?: unknown,
  ): Promise<Record<string, unknown>> {
    const resp = await fetch(`${CLOUD_API_BASE}${fullPath}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(
        `UniFi Cloud API ${method} ${fullPath} failed (${resp.status}): ${text}`,
      );
    }

    return await resp.json();
  }

  return {
    siteName,
    hostId,
    rawRequest,
    client: {
      request(path, method = "GET", body?) {
        return rawRequest(`${connectorBase}${path}`, method, body);
      },
      async cleanup() {
        // No cleanup needed for cloud API
      },
    },
  };
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1073741824) return `${(bytes / 1048576).toFixed(1)} MB`;
  return `${(bytes / 1073741824).toFixed(2)} GB`;
}

export const model = {
  type: "@stack72/unifi-traffic",
  version: "2026.03.06.13",
  globalArguments: GlobalArgsSchema,
  resources: {
    siteTraffic: {
      description: "Hourly site traffic data for the past 24 hours",
      schema: SiteTrafficSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    clientTraffic: {
      description: "Current client traffic snapshot with top talkers",
      schema: ClientTrafficSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    dpiStats: {
      description: "Deep packet inspection category breakdown",
      schema: DpiStatsSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  files: {
    log: {
      description: "Collection log",
      contentType: "text/plain",
      lifetime: "7d",
      garbageCollection: 5,
      streaming: true,
    },
  },
  methods: {
    collect: {
      description:
        "Collect traffic data from the UniFi Dream Machine for the past 24 hours (local or cloud)",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const { mode, host, username, password, site, apiKey } =
          context.globalArgs;
        const dataHandles = [];

        const logWriter = context.createFileWriter("log", "collection", {
          streaming: true,
        });

        await logWriter.writeLine(
          `[${
            new Date().toISOString()
          }] Starting UniFi traffic collection (${mode} mode)`,
        );

        let client: ApiClient;
        let apiBasePath: string;
        let cloud: CloudClient | undefined;

        if (mode === "local") {
          if (!host || !username || !password) {
            throw new Error(
              "Local mode requires host, username, and password",
            );
          }
          await logWriter.writeLine(
            `[${new Date().toISOString()}] Connecting to ${host}...`,
          );
          client = await createLocalClient(host, username, password);
          apiBasePath = `/proxy/network/api/s/${site}`;
          await logWriter.writeLine(
            `[${new Date().toISOString()}] Authenticated to local controller`,
          );
        } else {
          if (!apiKey) {
            throw new Error("Cloud mode requires apiKey");
          }
          await logWriter.writeLine(
            `[${new Date().toISOString()}] Connecting via Cloud API...`,
          );
          cloud = await createCloudClient(apiKey, site);
          client = cloud.client;
          apiBasePath = "";
          await logWriter.writeLine(
            `[${
              new Date().toISOString()
            }] Connected to site: ${cloud.siteName}`,
          );
        }

        try {
          // 1. Collect hourly site traffic for last 24h
          await logWriter.writeLine(
            `[${new Date().toISOString()}] Fetching hourly site traffic...`,
          );
          const now = Date.now();
          const oneDayAgo = now - 86400000;

          const siteStats = await client.request(
            `${apiBasePath}/stat/report/hourly.site`,
            "POST",
            {
              attrs: [
                "bytes",
                "wan-tx_bytes",
                "wan-rx_bytes",
                "wlan_bytes",
                "num_sta",
                "lan-num_sta",
                "wlan-num_sta",
                "time",
              ],
              start: oneDayAgo,
              end: now,
            },
          );

          const rawHourly =
            (siteStats as { data?: Array<Record<string, unknown>> }).data || [];
          const hourly = rawHourly.map((h) => ({
            time: h.time as number,
            bytes: (h.bytes as number) || 0,
            wanTxBytes: (h["wan-tx_bytes"] as number) || 0,
            wanRxBytes: (h["wan-rx_bytes"] as number) || 0,
            wlanBytes: (h.wlan_bytes as number) || 0,
            numSta: (h.num_sta as number) || 0,
            lanNumSta: (h["lan-num_sta"] as number) || 0,
            wlanNumSta: (h["wlan-num_sta"] as number) || 0,
          }));

          const totalBytes = hourly.reduce((s, h) => s + (h.bytes || 0), 0);
          const totalWanTx = hourly.reduce(
            (s, h) => s + (h.wanTxBytes || 0),
            0,
          );
          const totalWanRx = hourly.reduce(
            (s, h) => s + (h.wanRxBytes || 0),
            0,
          );
          const totalWlanBytes = hourly.reduce(
            (s, h) => s + (h.wlanBytes || 0),
            0,
          );

          const peakHourEntry = hourly.reduce(
            (max, h) => ((h.bytes || 0) > (max.bytes || 0) ? h : max),
            hourly[0] || { time: 0, bytes: 0 },
          );

          const avgClients = hourly.length > 0
            ? Math.round(
              hourly.reduce((s, h) => s + (h.numSta || 0), 0) / hourly.length,
            )
            : 0;

          const siteTrafficData = {
            collectedAt: new Date().toISOString(),
            periodStart: new Date(oneDayAgo).toISOString(),
            periodEnd: new Date(now).toISOString(),
            hourly,
            totalBytes,
            totalWanTx,
            totalWanRx,
            totalWlanBytes,
            peakHour: {
              time: new Date(peakHourEntry.time).toISOString(),
              bytes: peakHourEntry.bytes || 0,
            },
            averageClients: avgClients,
          };

          const siteHandle = await context.writeResource(
            "siteTraffic",
            "siteTraffic",
            siteTrafficData,
          );
          dataHandles.push(siteHandle);

          await logWriter.writeLine(
            `[${new Date().toISOString()}] Site traffic: ${
              formatBytes(totalBytes)
            } total | ${formatBytes(totalWanRx)} download | ${
              formatBytes(totalWanTx)
            } upload | Peak: ${formatBytes(peakHourEntry.bytes || 0)} at ${
              new Date(peakHourEntry.time).toLocaleTimeString()
            }`,
          );

          // 2. Collect active client stats
          await logWriter.writeLine(
            `[${new Date().toISOString()}] Fetching active clients...`,
          );

          const clientStats = await client.request(
            `${apiBasePath}/stat/sta`,
          );

          // Build device name lookup from multiple sources
          const deviceNames: Record<string, string> = {};

          // Source 1: rest/user (user-assigned names and hostnames)
          try {
            const allUsers = await client.request(
              `${apiBasePath}/rest/user`,
            );
            const rawUsers =
              (allUsers as { data?: Array<Record<string, unknown>> }).data ||
              [];
            for (const u of rawUsers) {
              const mac = (u.mac as string || "").toLowerCase();
              const name = (u.name as string) ||
                (u.hostname as string) ||
                (u.display_name as string);
              if (mac && name) {
                deviceNames[mac] = name;
              }
            }
          } catch {
            // rest/user may not be available
          }

          // Source 2: v2/clients/active (fingerprint-resolved display names from cloud API)
          if (cloud) {
            try {
              const v2Path =
                `/v1/connector/consoles/${cloud.hostId}/proxy/network/v2/api/site/${cloud.siteName}/clients/active`;
              const v2Result = await cloud.rawRequest(v2Path);
              const v2Clients = Array.isArray(v2Result)
                ? v2Result
                : (v2Result as { data?: Array<Record<string, unknown>> })
                  .data || [];
              for (const vc of v2Clients as Array<Record<string, unknown>>) {
                const mac = (vc.mac as string || "").toLowerCase();
                if (mac && !deviceNames[mac]) {
                  const name = (vc.display_name as string) ||
                    (vc.name as string);
                  if (name) {
                    deviceNames[mac] = name;
                  }
                }
              }
            } catch {
              // v2 API may not be available
            }
          }

          await logWriter.writeLine(
            `[${new Date().toISOString()}] Loaded ${
              Object.keys(deviceNames).length
            } device name mappings`,
          );

          const rawClients =
            (clientStats as { data?: Array<Record<string, unknown>> }).data ||
            [];
          const clients = rawClients.map((c) => {
            const mac = (c.mac as string || "").toLowerCase();
            const displayName = deviceNames[mac] ||
              (c.name as string) ||
              (c.hostname as string) ||
              mac;
            return {
              mac,
              ip: (c.ip as string) || undefined,
              hostname: (c.hostname as string) || undefined,
              name: displayName,
              rxBytes: (c.rx_bytes as number) || 0,
              txBytes: (c.tx_bytes as number) || 0,
              totalBytes: ((c.rx_bytes as number) || 0) +
                ((c.tx_bytes as number) || 0),
              bytesRate: (c["bytes-r"] as number) || undefined,
              isWired: (c.is_wired as boolean) || false,
              essid: (c.essid as string) || undefined,
              network: (c.network as string) || undefined,
              signal: (c.signal as number) || undefined,
              uptime: (c.uptime as number) || undefined,
            };
          });

          const sortedByUsage = [...clients].sort(
            (a, b) => b.totalBytes - a.totalBytes,
          );
          const totalClientBytes = clients.reduce(
            (s, c) => s + c.totalBytes,
            0,
          );

          const topClients = sortedByUsage.slice(0, 10).map((c) => ({
            name: c.name || c.hostname || c.mac,
            totalBytes: c.totalBytes,
            percentage: totalClientBytes > 0
              ? Math.round((c.totalBytes / totalClientBytes) * 10000) / 100
              : 0,
          }));

          const wiredCount = clients.filter((c) => c.isWired).length;
          const wirelessCount = clients.filter((c) => !c.isWired).length;

          const clientTrafficData = {
            collectedAt: new Date().toISOString(),
            clientCount: clients.length,
            wiredCount,
            wirelessCount,
            clients: sortedByUsage,
            topClientsByUsage: topClients,
          };

          const clientHandle = await context.writeResource(
            "clientTraffic",
            "clientTraffic",
            clientTrafficData,
          );
          dataHandles.push(clientHandle);

          await logWriter.writeLine(
            `[${
              new Date().toISOString()
            }] Clients: ${clients.length} active (${wiredCount} wired, ${wirelessCount} wireless)`,
          );
          for (const tc of topClients.slice(0, 5)) {
            await logWriter.writeLine(
              `  - ${tc.name}: ${
                formatBytes(tc.totalBytes)
              } (${tc.percentage}%)`,
            );
          }

          // 3. Collect DPI stats
          await logWriter.writeLine(
            `[${new Date().toISOString()}] Fetching DPI statistics...`,
          );

          let dpiData: Array<Record<string, unknown>> = [];

          // Try stadpi (per-client DPI) then sitedpi (site-level DPI)
          for (const endpoint of ["stat/stadpi", "stat/sitedpi"]) {
            if (dpiData.length > 0) break;
            try {
              const result = await client.request(
                `${apiBasePath}/${endpoint}`,
                "POST",
                { type: "by_cat" },
              );
              const data =
                (result as { data?: Array<Record<string, unknown>> }).data ||
                [];
              const nonEmpty = data.filter((d) => Object.keys(d).length > 0);
              if (nonEmpty.length > 0) {
                dpiData = nonEmpty;
                await logWriter.writeLine(
                  `[${
                    new Date().toISOString()
                  }] DPI data from ${endpoint}: ${nonEmpty.length} entries`,
                );
              }
            } catch {
              // endpoint may not be available or may require CSRF
            }
          }

          if (dpiData.length === 0) {
            await logWriter.writeLine(
              `[${
                new Date().toISOString()
              }] DPI data not yet available — DPI stats accumulate over time as traffic flows through the UDM`,
            );
          }

          // Aggregate DPI data
          const categoryTotals: Record<number, { rx: number; tx: number }> = {};

          for (const entry of dpiData) {
            // Format 1: entry has by_cat array (per-client DPI from stadpi)
            const cats = (entry.by_cat as Array<Record<string, unknown>>) || [];
            for (const cat of cats) {
              const catCode = cat.cat as number;
              if (!categoryTotals[catCode]) {
                categoryTotals[catCode] = { rx: 0, tx: 0 };
              }
              categoryTotals[catCode].rx += (cat.rx_bytes as number) || 0;
              categoryTotals[catCode].tx += (cat.tx_bytes as number) || 0;
            }

            // Format 2: entry itself has cat/rx_bytes/tx_bytes (site-level DPI)
            if (typeof entry.cat === "number") {
              const catCode = entry.cat as number;
              if (!categoryTotals[catCode]) {
                categoryTotals[catCode] = { rx: 0, tx: 0 };
              }
              categoryTotals[catCode].rx += (entry.rx_bytes as number) || 0;
              categoryTotals[catCode].tx += (entry.tx_bytes as number) || 0;
            }
          }

          const categories = Object.entries(categoryTotals).map(
            ([code, totals]) => {
              const catCode = parseInt(code);
              return {
                category: DPI_CATEGORIES[catCode] || `Category ${catCode}`,
                categoryCode: catCode,
                rxBytes: totals.rx,
                txBytes: totals.tx,
                totalBytes: totals.rx + totals.tx,
              };
            },
          ).sort((a, b) => b.totalBytes - a.totalBytes);

          const totalDpiBytes = categories.reduce(
            (s, c) => s + c.totalBytes,
            0,
          );

          const topCategories = categories.slice(0, 10).map((c) => ({
            category: c.category,
            totalBytes: c.totalBytes,
            percentage: totalDpiBytes > 0
              ? Math.round((c.totalBytes / totalDpiBytes) * 10000) / 100
              : 0,
          }));

          const dpiStatsData = {
            collectedAt: new Date().toISOString(),
            categories,
            topCategories,
          };

          const dpiHandle = await context.writeResource(
            "dpiStats",
            "dpiStats",
            dpiStatsData,
          );
          dataHandles.push(dpiHandle);

          await logWriter.writeLine(
            `[${
              new Date().toISOString()
            }] DPI: ${categories.length} categories detected`,
          );
          for (const tc of topCategories.slice(0, 5)) {
            await logWriter.writeLine(
              `  - ${tc.category}: ${
                formatBytes(tc.totalBytes)
              } (${tc.percentage}%)`,
            );
          }

          await logWriter.writeLine(
            `[${new Date().toISOString()}] Collection complete`,
          );
        } finally {
          await client.cleanup();
          await logWriter.writeLine(
            `[${new Date().toISOString()}] Connection closed`,
          );
          const logHandle = await logWriter.finalize();
          dataHandles.push(logHandle);
        }

        return { dataHandles };
      },
    },
  },
};
