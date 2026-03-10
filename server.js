import express from "express";
import cors from "cors";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const app = express();
app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "mcp-session-id"],
  exposedHeaders: ["mcp-session-id"],
}));
app.use(express.json());

const PORT = process.env.PORT || 3000;
const CLIENT_ID = process.env.PISTE_CLIENT_ID;
const CLIENT_SECRET = process.env.PISTE_CLIENT_SECRET;
const JUDILIBRE_BASE = "https://api.piste.gouv.fr/cassation/judilibre/v1.0";

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
  if (!res.ok) throw new Error(`Auth PISTE échouée: ${await res.text()}`);
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

// ─── Création du serveur MCP ──────────────────────────────────────────────────
function createMcpServer() {
  const server = new McpServer({ name: "judilibre-mcp", version: "1.0.0" });

  server.tool(
    "judilibre_rechercher",
    "Recherche des décisions de justice dans la base Judilibre de la Cour de cassation (plein texte et/ou filtres par chambre, date, solution…).",
    {
      query: z.string().optional().describe("Texte libre à rechercher"),
      operator: z.enum(["or", "and", "exact"]).optional().describe("Opérateur : or, and, exact"),
      chamber: z.string().optional().describe("Chambre : 'Chambre civile 1', 'Chambre commerciale', 'Chambre criminelle', 'Chambre sociale', 'Assemblée plénière'…"),
      formation: z.string().optional().describe("Formation de jugement"),
      solution: z.string().optional().describe("Solution : Cassation, Rejet, Irrecevabilité…"),
      date_start: z.string().optional().describe("Date début YYYY-MM-DD"),
      date_end: z.string().optional().describe("Date fin YYYY-MM-DD"),
      publication: z.string().optional().describe("b=Bulletin, r=Rapport, l=Lettre, c=Communiqué"),
      field: z.string().optional().describe("Zone : all, expose, moyens, motivations, dispositif, summary, number"),
      page_size: z.number().optional().describe("Résultats par page (max 50)"),
      page: z.number().optional().describe("Numéro de page (commence à 0)"),
      sort: z.enum(["score", "date_asc", "date_desc"]).optional().describe("Tri des résultats"),
    },
    async (args) => {
      const data = await callJudilibre("/search", {
        query: args.query, operator: args.operator, chamber: args.chamber,
        formation: args.formation, solution: args.solution, date_start: args.date_start,
        date_end: args.date_end, publication: args.publication, field: args.field,
        page_size: args.page_size ?? 10, page: args.page ?? 0, sort: args.sort ?? "score",
      });
      if (!data.results || data.results.length === 0) {
        return { content: [{ type: "text", text: "Aucune décision trouvée pour ces critères." }] };
      }
      const lines = [`**${data.total} décision(s) trouvée(s)** (page ${(args.page ?? 0) + 1})\n`];
      for (const r of data.results) {
        lines.push(`---`);
        lines.push(`**${r.chamber || "Chambre inconnue"}** — ${r.formation || ""}`);
        lines.push(`📅 ${r.decision_date || "Date inconnue"} | 🔖 Pourvoi n° ${r.number || "N/A"}`);
        lines.push(`⚖️ Solution : ${r.solution || "Non précisée"}`);
        if (r.publication?.length) lines.push(`📚 Publication : ${r.publication.join(", ")}`);
        if (r.summary?.length) lines.push(`\n*Sommaire :* ${r.summary[0]}`);
        lines.push(`🆔 ID : \`${r.id}\``);
      }
      if (data.next_page !== undefined) lines.push(`\n*(Page suivante : page=${data.next_page})*`);
      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );

  server.tool(
    "judilibre_decision",
    "Récupère le texte intégral et toutes les métadonnées d'une décision par son identifiant Judilibre.",
    { id: z.string().describe("Identifiant de la décision (obtenu via judilibre_rechercher)") },
    async ({ id }) => {
      const data = await callJudilibre("/decision", { id });
      const lines = [
        `# ${data.chamber || "Décision"} — ${data.decision_date || ""}`,
        `**Numéro de pourvoi :** ${data.number || "N/A"}`,
        `**Formation :** ${data.formation || "N/A"}`,
        `**Solution :** ${data.solution || "N/A"}`,
        `**Publication :** ${(data.publication || []).join(", ") || "Non publiée"}`, "",
      ];
      if (data.summary?.length) lines.push("## Sommaire", data.summary.join("\n\n"), "");
      if (data.text) lines.push("## Texte intégral", data.text);
      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );

  server.tool(
    "judilibre_taxonomie",
    "Liste les valeurs possibles pour les filtres de recherche Judilibre.",
    {
      attribut: z.enum(["chamber", "formation", "solution", "publication", "jurisdiction", "theme", "location"])
        .optional().describe("Attribut à lister"),
    },
    async ({ attribut }) => {
      const data = await callJudilibre("/taxonomy", attribut ? { attribut } : {});
      const lines = [`**Valeurs disponibles${attribut ? ` pour "${attribut}"` : ""} :**\n`];
      for (const item of data) lines.push(`- **${item.id}** : ${item.label || item.id}`);
      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );

  server.tool(
    "judilibre_statistiques",
    "Statistiques générales de la base Judilibre (nombre de décisions, période couverte…).",
    {},
    async () => {
      const data = await callJudilibre("/stats");
      const lines = [`**Statistiques Judilibre**\n`];
      if (data.index) lines.push(`📊 Décisions indexées : **${data.index.total?.toLocaleString("fr-FR") || "N/A"}**`);
      if (data.date) {
        lines.push(`📅 Décision la plus ancienne : ${data.date.min || "N/A"}`);
        lines.push(`📅 Décision la plus récente : ${data.date.max || "N/A"}`);
      }
      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );

  return server;
}

// ─── Gestion des sessions MCP (Streamable HTTP) ───────────────────────────────
const transports = new Map();

app.all("/mcp", async (req, res) => {
  try {
    const sessionId = req.headers["mcp-session-id"];

    if (req.method === "POST" && !sessionId) {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
      });
      const server = createMcpServer();
      await server.connect(transport);
      await transport.handleRequest(req, res);
      const sid = res.getHeader("mcp-session-id");
      if (sid) {
        transports.set(sid, transport);
        transport.onclose = () => transports.delete(sid);
      }
      return;
    }

    if (sessionId && transports.has(sessionId)) {
      return await transports.get(sessionId).handleRequest(req, res);
    }

    res.status(400).json({ error: "Session MCP invalide ou expirée. Reconnectez-vous." });
  } catch (err) {
    console.error("Erreur MCP:", err.message);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

app.get("/", (req, res) => {
  res.json({ name: "Serveur MCP Judilibre", version: "1.0.0", status: "ok", endpoint: "/mcp" });
});

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error("❌ Variables manquantes : PISTE_CLIENT_ID et PISTE_CLIENT_SECRET");
  process.exit(1);
}

app.listen(PORT, () => console.log(`✅ Serveur MCP Judilibre démarré sur le port ${PORT}`));
