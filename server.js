import express from "express";
import cors from "cors";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const PORT = process.env.PORT || 3000;
const CLIENT_ID = process.env.PISTE_CLIENT_ID;
const CLIENT_SECRET = process.env.PISTE_CLIENT_SECRET;
const JUDILIBRE_BASE = "https://api.piste.gouv.fr/cassation/judilibre/v1.0";

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error("❌ PISTE_CLIENT_ID et PISTE_CLIENT_SECRET sont requis");
  process.exit(1);
}

// ─── Auth PISTE OAuth2 ────────────────────────────────────────────────────────
let tokenCache = { token: null, expiresAt: 0 };

async function getAccessToken() {
  if (tokenCache.token && Date.now() < tokenCache.expiresAt - 30000) return tokenCache.token;
  const res = await fetch("https://identity.piste.gouv.fr/api/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      scope: "openid",
    }),
  });
  if (!res.ok) throw new Error(`Auth PISTE: ${await res.text()}`);
  const data = await res.json();
  tokenCache = { token: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
  return tokenCache.token;
}

async function callJudilibre(endpoint, params = {}) {
  const token = await getAccessToken();
  const url = new URL(`${JUDILIBRE_BASE}${endpoint}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  }
  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`Judilibre (${res.status}): ${await res.text()}`);
  return res.json();
}

// ─── Serveur MCP (stateless — sessionIdGenerator: undefined) ─────────────────
const mcpServer = new McpServer({ name: "judilibre-mcp", version: "1.0.0" });

mcpServer.tool(
  "judilibre_rechercher",
  "Recherche des décisions de justice dans Judilibre (Cour de cassation). Plein texte et/ou filtres par chambre, date, solution…",
  {
    query: z.string().optional().describe("Texte libre à rechercher"),
    operator: z.enum(["or", "and", "exact"]).optional().describe("Opérateur : or, and, exact"),
    chamber: z.string().optional().describe("Ex: 'Chambre civile 1', 'Chambre commerciale', 'Chambre criminelle', 'Chambre sociale', 'Assemblée plénière'"),
    solution: z.string().optional().describe("Ex: Cassation, Rejet, Irrecevabilité"),
    date_start: z.string().optional().describe("Date début YYYY-MM-DD"),
    date_end: z.string().optional().describe("Date fin YYYY-MM-DD"),
    publication: z.string().optional().describe("b=Bulletin, r=Rapport, l=Lettre, c=Communiqué"),
    page_size: z.number().optional().describe("Résultats par page (max 50, défaut 10)"),
    page: z.number().optional().describe("Numéro de page (commence à 0)"),
    sort: z.enum(["score", "date_asc", "date_desc"]).optional(),
  },
  async (args) => {
    const data = await callJudilibre("/search", {
      query: args.query, operator: args.operator, chamber: args.chamber,
      solution: args.solution, date_start: args.date_start, date_end: args.date_end,
      publication: args.publication, page_size: args.page_size ?? 10,
      page: args.page ?? 0, sort: args.sort ?? "score",
    });
    if (!data.results?.length) {
      return { content: [{ type: "text", text: "Aucune décision trouvée." }] };
    }
    const lines = [`**${data.total} décision(s)** (page ${(args.page ?? 0) + 1})\n`];
    for (const r of data.results) {
      lines.push(`---`);
      lines.push(`**${r.chamber || "?"}** — ${r.formation || ""}`);
      lines.push(`📅 ${r.decision_date || "?"} | Pourvoi n° ${r.number || "N/A"}`);
      lines.push(`⚖️ ${r.solution || "Solution non précisée"}`);
      if (r.publication?.length) lines.push(`📚 ${r.publication.join(", ")}`);
      if (r.summary?.length) lines.push(`*${r.summary[0]}*`);
      lines.push(`ID: \`${r.id}\``);
    }
    if (data.next_page !== undefined) lines.push(`\n→ Page suivante : page=${data.next_page}`);
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }
);

mcpServer.tool(
  "judilibre_decision",
  "Récupère le texte intégral et toutes les métadonnées d'une décision par son identifiant.",
  { id: z.string().describe("ID de la décision (obtenu via judilibre_rechercher)") },
  async ({ id }) => {
    const d = await callJudilibre("/decision", { id });
    const lines = [
      `# ${d.chamber || "Décision"} — ${d.decision_date || ""}`,
      `**Pourvoi :** ${d.number || "N/A"} | **Formation :** ${d.formation || "N/A"}`,
      `**Solution :** ${d.solution || "N/A"} | **Publication :** ${(d.publication || []).join(", ") || "—"}`,
      "",
    ];
    if (d.summary?.length) lines.push("## Sommaire", d.summary.join("\n\n"), "");
    if (d.text) lines.push("## Texte intégral", d.text);
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }
);

mcpServer.tool(
  "judilibre_taxonomie",
  "Liste les valeurs possibles pour les filtres (chambres, formations, solutions…).",
  {
    attribut: z.enum(["chamber", "formation", "solution", "publication", "jurisdiction", "theme", "location"])
      .optional(),
  },
  async ({ attribut }) => {
    const data = await callJudilibre("/taxonomy", attribut ? { attribut } : {});
    const lines = [`**Valeurs pour ${attribut || "tous les attributs"} :**\n`];
    for (const item of data) lines.push(`- **${item.id}** : ${item.label || item.id}`);
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }
);

mcpServer.tool(
  "judilibre_statistiques",
  "Statistiques de la base Judilibre (nombre de décisions, période couverte…).",
  {},
  async () => {
    const data = await callJudilibre("/stats");
    const lines = ["**Statistiques Judilibre**\n"];
    if (data.index) lines.push(`Décisions : **${data.index.total?.toLocaleString("fr-FR")}**`);
    if (data.date) {
      lines.push(`Période : ${data.date.min} → ${data.date.max}`);
    }
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }
);

// ─── Transport stateless (recommandé pour Render / cloud) ────────────────────
const transport = new StreamableHTTPServerTransport({
  sessionIdGenerator: undefined, // stateless
});

await mcpServer.connect(transport);

// ─── Express ──────────────────────────────────────────────────────────────────
const app = express();
app.use(cors({ origin: "*", methods: ["GET", "POST", "DELETE", "OPTIONS"], allowedHeaders: "*" }));
app.use(express.json());

app.post("/mcp", (req, res) => transport.handleRequest(req, res));
app.get("/mcp", (req, res) => transport.handleRequest(req, res));
app.delete("/mcp", (req, res) => transport.handleRequest(req, res));

app.get("/", (req, res) => res.json({ name: "judilibre-mcp", version: "1.0.0", status: "ok" }));

app.listen(PORT, () => console.log(`✅ Serveur MCP Judilibre démarré sur le port ${PORT}`));
